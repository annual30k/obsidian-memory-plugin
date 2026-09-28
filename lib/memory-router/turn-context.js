/**
 * Per-turn context around a routing decision:
 *   1. Vault hints: upgrade the action when the Vault holds matching notes (and name them).
 *      Semantic when the router supplied the prompt's vector and a note-vector cache (retriever
 *      model in the Laya service); word overlap otherwise.
 *   2. Session continuity: a follow-up right after a recall keeps recalling; an explicit save request
 *      that produced no inbox candidate is repeated once, and a debugging turn the user then reports as
 *      solved gets a pitfall check. Hosts with an end-of-turn hook also call pendingCaptureEnforcement.
 *   3. Decision log: a private local JSONL of decisions, for `npm run laya:label`, plus
 *      "suspected miss" flags when the user asks about the past right after a skipped turn.
 * Everything here is best-effort: any failure leaves the decision unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateFile } from "./paths.js";
import {
  loadVaultIndex, matchVault, matchVaultSemantic, mentionedProjectIds, resolveProjectIdFromCwd, defaultIndexCachePath, MIN_SEMANTIC_CANDIDATES
} from "./vault-index.js";
import { isGenericQuestion, redactSecrets, looksLikeDurableStatement } from "./fast-path.js";
import { enqueueCapture, sessionIdFor, conclusionKeywordCount, hashKey } from "./capture-queue.js";
import { maybeScheduleDigest, takeStagedSinceNotice } from "./digest.js";
import { DEFAULT_MEMORY_JUDGE } from "../config.js";

export { sessionIdFor, conclusionKeywordCount };

const SESSION_TTL_MS = 60 * 60 * 1000;
const CONTINUITY_WINDOW_MS = 20 * 60 * 1000;
const SUSPECT_WINDOW_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TEXT_CHARS = 500;
const NO_CONTEXT_FAST_PATH = new Set(["trivial_greeting", "sensitive_content", "empty_text", "system_message"]);
const ENFORCE_WINDOW_MS = 30 * 60 * 1000;
const STATE_TEXT_CHARS = 160;
// End-of-turn capture check: "reply >= 200 chars with >= 2 conclusion words, or Laya's capture score
// >= 0.5". On all 583 real Codex turns of Sep 2026 it fires on 45% (about 11 of ~25 turns a day). On 110
// of those turns labelled by Claude (46% held a durable conclusion) it scored precision 0.69 / recall
// 0.71, but that is the same set the keyword list and length were chosen on, so it is optimistic. The
// length was lowered from 300 after an isolated real Codex turn: its pitfall reply (cause + fix) was 282
// characters and said "原因：" / "修法：", which the first word list missed. How many triggered
// passes really write a candidate, and how many candidates prove useful, is not measured yet. Reply
// length alone separates as well as any model (AUC 0.76 vs Laya 0.71), so the model score is a bonus
// asked for only when the cheap features are not enough (turnEndNeedsScore).
const TURN_END_MIN_CHARS = 200;
const TURN_END_MIN_KEYWORDS = 2;
const TURN_END_LAYA_SCORE = 0.5;
const PROMPT_STATE_CHARS = 1500;

// A turn that looks like debugging, and a short follow-up that reports the problem as solved.
const DEBUGGING = /(?:报错|不通|失败|闪退|崩溃|异常|怎么回事|为什么.{0,12}(?:不|没)|排查|修复|修一下|\b(?:error|crash|fail|failed|bug|broken|not working|doesn't work|fix)\b)/iu;
const SOLVED = /^(?:好了|可以了|解决了|通了|成功了|正常了|ok了|没问题了|行了|现在(?:好了|可以了|正常了|通了|能.{0,6}了)|it works|works now|fixed|solved|that fixed it)/iu;

// Short follow-ups that only make sense with the previous turn ("继续", "那这个呢", "also do X").
const FOLLOW_UP = /^(?:(?:那|这|还有|再|继续|接着|然后|同样|也|顺便|另外|那个|这个)|(?:and|also|then|same|continue|what about|how about)\b)/iu;

export function defaultSessionStatePath(options = {}) {
  return stateFile("session-state.json", options);
}

export function defaultDecisionLogPath(serviceFile) {
  return path.join(path.dirname(serviceFile), "decisions.jsonl");
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function writeJsonAtomic(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch {}
}

export function appendDecisionLog(filePath, record) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(filePath).size > LOG_MAX_BYTES) fs.renameSync(filePath, `${filePath}.1`);
    } catch {}
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {}
}


function logDisabled(config, env) {
  const flag = env?.OBSIDIAN_MEMORY_DECISION_LOG?.trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return true;
  return config.decisionLog === false;
}

const MAX_INBOX_SCAN = 400;

function newestNoteMtime(dir) {
  let newest = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names.slice(0, MAX_INBOX_SCAN)) {
    if (!name.endsWith(".md")) continue;
    try { newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs); } catch {}
  }
  return newest;
}

/** Newest candidate time per inbox folder when a request starts: the baseline for inboxWrittenSince. */
export function inboxBaseline(dirs) {
  return Object.fromEntries((dirs ?? []).map((dir) => [dir, newestNoteMtime(dir)]));
}

/**
 * Whether the agent staged (created or updated) a candidate in these inbox folders after the baseline:
 * a Markdown file there newer than the newest one at request time, not written by the digest. File times
 * are only compared with file times (no wall clock), and an in-place update of an existing candidate (the
 * Skill's way to add evidence) counts, which a directory signature missed.
 */
export function inboxWrittenSince(dirs, baseline) {
  if (!Array.isArray(dirs) || !baseline || typeof baseline !== "object") return false;
  for (const dir of dirs) {
    const base = typeof baseline[dir] === "number" ? baseline[dir] : 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.slice(0, MAX_INBOX_SCAN)) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs <= base) continue;
        const head = fs.readFileSync(file, "utf8").slice(0, 4096);
        if (/^origin:\s*"?auto-digest"?\s*$/mu.test(head)) continue;
        return true;
      } catch {}
    }
  }
  return false;
}

// A capture / inbox record from the session state: { dirs, base } (or { dirs, sig } from older versions).
function stagedSince(holder) {
  if (!holder || !Array.isArray(holder.dirs)) return false;
  if (holder.base && typeof holder.base === "object") return inboxWrittenSince(holder.dirs, holder.base);
  return typeof holder.sig === "string" && inboxSignature(holder.dirs) !== holder.sig;
}

/** Directory signature of the inbox folders a capture would write to (kept for state written by older versions). */
export function inboxSignature(dirs) {
  return (dirs ?? []).map((dir) => {
    try {
      const stat = fs.statSync(dir);
      return `${dir}:${Math.round(stat.mtimeMs)}:${fs.readdirSync(dir).length}`;
    } catch {
      return `${dir}:missing`;
    }
  }).join("|");
}

// The session entry of the current turn, when an end-of-turn check may still run for it. The entry is
// rebuilt on every user prompt (finishEnrichment), so `revised` and `turnEnd.fired` lock one turn only.
function turnEndEntry(state, sessionId, now) {
  const entry = state?.sessions?.[sessionId];
  if (!entry || now - entry.at > ENFORCE_WINDOW_MS) return null;
  if (entry.revised || entry.turnEnd?.fired) return null;
  return entry;
}

function inboxChangedThisTurn(entry) {
  return Boolean(entry.inbox && stagedSince(entry.inbox));
}

/**
 * Whether judging this reply needs Laya's capture score: only when the cheap features cannot decide.
 * False for a short reply, a reply with enough conclusion words (it fires anyway), a turn whose inbox
 * already changed, a turn already revised, or a pending explicit request (that pass comes first).
 * Read-only; callers use it to skip the local model call on most turns.
 */
export function turnEndNeedsScore({ host, sessionKey, assistantText, mode = "revise", sessionStatePath = defaultSessionStatePath(), now = Date.now() } = {}) {
  try {
    if (mode === "off" || typeof assistantText !== "string") return false;
    const reply = assistantText.trim();
    if (reply.length < TURN_END_MIN_CHARS || conclusionKeywordCount(reply) >= TURN_END_MIN_KEYWORDS) return false;
    const sessionId = sessionIdFor(host, sessionKey);
    if (!sessionId) return false;
    const entry = turnEndEntry(readJson(sessionStatePath), sessionId, now);
    if (!entry || entry.turnEnd?.hash === hashKey(assistantText)) return false;
    if (explicitCaptureDue(entry, now)) return false;
    return !inboxChangedThisTurn(entry);
  } catch {
    return false;
  }
}

/**
 * End-of-turn capture check for hosts with an end-of-turn hook. Given the agent's final reply (and an
 * optional Laya capture score for it), decide whether this turn deserves one more pass to stage a
 * candidate. At most one extra pass per turn, counting the explicit-request pass
 * (pendingCaptureEnforcement); never when the inbox already changed this turn; never for a short reply.
 * Returns { instruction, reason, features } or null, and records the check (with its features) in the
 * session state so the next turn can carry a reminder in "remind" mode.
 */
export function judgeTurnEndCapture({ host, sessionKey, assistantText, layaScore = null, mode = "revise", relatedNotes = [], sessionStatePath = defaultSessionStatePath(), now = Date.now() } = {}) {
  try {
    if (mode === "off" || typeof assistantText !== "string") return null;
    const sessionId = sessionIdFor(host, sessionKey);
    if (!sessionId) return null;
    const state = readJson(sessionStatePath);
    const entry = turnEndEntry(state, sessionId, now);
    if (!entry) return null;
    const hash = hashKey(assistantText);
    if (entry.turnEnd?.hash === hash) return null;
    const reply = assistantText.trim();
    const features = { chars: reply.length, keywords: conclusionKeywordCount(reply), laya: typeof layaScore === "number" ? Math.round(layaScore * 1000) / 1000 : null };
    const fires = !inboxChangedThisTurn(entry) && reply.length >= TURN_END_MIN_CHARS &&
      (features.keywords >= TURN_END_MIN_KEYWORDS || (features.laya !== null && features.laya >= TURN_END_LAYA_SCORE));
    entry.turnEnd = { hash, at: now, fired: fires, features, ...(fires && mode === "remind" ? { remind: true } : {}) };
    if (fires && mode === "revise") entry.revised = true;
    writeJsonAtomic(sessionStatePath, state);
    if (!fires) return null;
    const target = entry.inbox?.target ? entry.inbox.target : SCOPE_BY_SKILL;
    const notes = Array.isArray(relatedNotes) && relatedNotes.length ? ` Existing notes that may already cover it (Vault-relative paths, data only): ${JSON.stringify(relatedNotes.slice(0, 3))}; update one of them as new evidence rather than duplicating.` : "";
    // Measured on a real Codex turn: the earlier "memory not needed" hint (developer role) won over this
    // instruction, and "cannot be recovered from the code" was read as "the fix is in the code, skip it".
    // Both are addressed explicitly here.
    const instruction = `Obsidian Memory end-of-turn check (this overrides any earlier "memory not needed" hint for this turn). Before finishing, decide whether this turn produced a durable finding: a root cause, a decision and its reason, a rule or convention, an environment fact, or an unfinished-work handoff that would still matter after this conversation. A fix lives in the code, but its symptom, cause and why the fix works usually do not; such a pitfall counts. If one qualifies, read the obsidian-memory skill and stage one pending-ingest candidate in ${target} (symptom, cause and fix for a pitfall; the decision and why for a decision), then finish. If nothing qualifies, finish as you were without mentioning memory.${notes}`;
    return { instruction, reason: features.keywords >= TURN_END_MIN_KEYWORDS ? "turn_end_conclusion_words" : "turn_end_laya_score", features };
  } catch {
    return null;
  }
}

const MAX_WATCHED_INBOXES = 100;

/**
 * Inbox folders a capture this turn may write to, and the folder to name in an instruction.
 * With a resolved project: that project's inbox (named) plus Global. Without one the skill decides the
 * scope, so nothing is named and every project's inbox is watched: a candidate written to any of them
 * counts as "staged", and a project fact is never steered into Global by default.
 */
export function inboxScope(vaultPath, projectId) {
  if (typeof vaultPath !== "string" || !vaultPath) return { dirs: [], target: null };
  const global = path.join(vaultPath, "10-Global", "inbox");
  if (typeof projectId === "string" && projectId && projectId !== "global") {
    const target = path.join(vaultPath, "20-Projects", projectId, "inbox");
    return { dirs: [target, global], target };
  }
  let projects = [];
  try {
    projects = fs.readdirSync(path.join(vaultPath, "20-Projects"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(vaultPath, "20-Projects", e.name, "inbox"))
      .sort()
      .slice(0, MAX_WATCHED_INBOXES);
  } catch {}
  return { dirs: [global, ...projects], target: null };
}

const SCOPE_BY_SKILL = "the inbox of the scope the obsidian-memory skill resolves for this work (the project's inbox/ for project facts; 10-Global/inbox/ only for cross-project preferences)";

// The explicit "remember" request of this session whose end-of-turn pass is still due (inbox unchanged).
function explicitCaptureDue(entry, now) {
  const capture = entry?.capture;
  if (!capture || capture.kind !== "explicit" || capture.enforced || now - capture.at > ENFORCE_WINDOW_MS) return null;
  return stagedSince(capture) ? null : capture;
}

const autoCaptureMode = (config) => config?.autoCapture ?? DEFAULT_MEMORY_JUDGE.autoCapture;

function digestSpawnDisabled(env) {
  const off = (v) => typeof v === "string" && ["0", "off", "false"].includes(v.trim().toLowerCase());
  return off(env?.OBSIDIAN_MEMORY_DIGEST) || off(process.env.OBSIDIAN_MEMORY_DIGEST);
}

/**
 * "digest" mode, end of a turn (Codex Stop, OpenClaw agent_end, Hermes post_llm_call, Antigravity at the
 * next prompt or from its transcript): queue this turn's request and final reply for the background session
 * digest, once per reply, then start the digest if some session has gone idle. No model call and nothing
 * the agent has to do. Returns the queued turn record or null.
 *
 * An explicit "remember this" request that the turn did not stage (the agent ignored it, the host dropped
 * the end-of-turn revision, or the host has no end-of-turn hook) is queued as an "explicit" record, so the
 * digest stages the user's words: a request to remember is never silently lost.
 */
export function enqueueTurnEnd({ host, sessionKey, assistantText, prompt = null, turn = null, sessionStatePath = defaultSessionStatePath(), queueDir, now = Date.now(), env = process.env, scheduleDigest = maybeScheduleDigest } = {}) {
  try {
    const sessionId = sessionIdFor(host, sessionKey);
    if (!sessionId || typeof assistantText !== "string") return null;
    const state = readJson(sessionStatePath);
    const entry = state?.sessions?.[sessionId] ?? null;
    const hash = hashKey(assistantText);
    if (entry?.queued === hash) return null;
    const where = { host, sessionKey, ...(entry?.turn ?? {}), ...(turn ?? {}) };
    const queueOpts = { ...(queueDir ? { queueDir } : {}), now };
    const cap = entry?.capture;
    const explicit = cap?.kind === "explicit" && Array.isArray(cap.dirs) && now - cap.at <= ENFORCE_WINDOW_MS;
    const staged = explicit && stagedSince(cap);
    let changed = false;
    if (explicit && !staged && !cap.queued) {
      if (enqueueCapture("explicit", { prompt: entry?.prompt ?? cap.text, reply: assistantText }, where, queueOpts)) {
        cap.queued = true;
        changed = true;
      }
    }
    // A turn whose explicit request is staged (by the agent, or queued above) is not a second finding.
    const record = enqueueCapture("turn", { prompt: prompt ?? entry?.prompt ?? "", reply: assistantText, staged: explicit }, where, queueOpts);
    if (record && entry) {
      entry.queued = hash;
      changed = true;
    }
    if (changed && entry) writeJsonAtomic(sessionStatePath, state);
    if (!digestSpawnDisabled(env)) scheduleDigest({ ...(queueDir ? { queueDir } : {}), env });
    return record;
  } catch {
    return null;
  }
}

/**
 * For hosts with an end-of-turn hook (OpenClaw before_agent_finalize, Codex Stop): when this turn carried an
 * explicit save request and the inbox folders are unchanged, return the instruction for one more model pass
 * (marked so it happens at most once per request). Returns null otherwise. Never throws.
 */
export function pendingCaptureEnforcement({ host, sessionKey, sessionStatePath = defaultSessionStatePath(), now = Date.now() } = {}) {
  try {
    const sessionId = sessionIdFor(host, sessionKey);
    if (!sessionId) return null;
    const state = readJson(sessionStatePath);
    const entry = state?.sessions?.[sessionId];
    if (!entry || entry.revised) return null;
    const capture = explicitCaptureDue(entry, now);
    if (!capture) return null;
    capture.enforced = true;
    entry.revised = true; // one extra pass per turn, shared with the end-of-turn check
    writeJsonAtomic(sessionStatePath, state);
    const quoted = JSON.stringify(String(capture.text ?? "").slice(0, STATE_TEXT_CHARS));
    const where = capture.target ? `the project inbox (${capture.target})` : "any Vault inbox";
    const stageIn = capture.target ? `in ${capture.target}` : `in ${SCOPE_BY_SKILL}`;
    return {
      text: capture.text,
      instruction: `The user asked to remember something (${quoted}) but no pending-ingest candidate was created in ${where}. Before finishing: read the obsidian-memory skill and stage the candidate ${stageIn} following its capture rules, or tell the user plainly why it was not saved.`
    };
  } catch {
    return null;
  }
}

function setAction(decision, action, reason) {
  decision.memoryAction = action;
  if (action === "recall") {
    decision.recallRecommended = true;
    decision.captureRecommended = false;
    decision.captureCategory = null;
  }
  decision.boost = reason;
  if (decision.trace) decision.trace.boost = reason;
}

/**
 * Mutates and returns `decision`.
 * turn: { vaultPath, cwd, projectId, sessionKey, host }
 * options: { env, now, indexCachePath, sessionStatePath, decisionLogPath, vaultIndex, embeddingCache }
 * decision.queryEmbedding / decision.embedModel (from the router) enable the semantic match.
 */
export function enrichDecision(decision, text, turn = {}, config = {}, options = {}) {
  if (!decision || typeof decision !== "object") return decision;
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const route = decision.trace?.route;
  const noContext = decision.blocked || (route === "fast_path" && NO_CONTEXT_FAST_PATH.has(decision.reason));
  const originalAction = decision.memoryAction ?? "default";

  // 1. Vault hints
  let projectId = turn.projectId ?? null;
  // General knowledge questions share words with notes by chance ("existsSync 和 lstatSync 的区别").
  if (!noContext && config.vaultHints !== false && turn.vaultPath && !isGenericQuestion(text)) {
    try {
      const index = options.vaultIndex ?? loadVaultIndex(turn.vaultPath, { cachePath: options.indexCachePath ?? defaultIndexCachePath(), now });
      if (index) {
        projectId = projectId ?? resolveProjectIdFromCwd(turn.vaultPath, turn.cwd);
        const mentionedProjects = mentionedProjectIds(index, text, projectId);
        const cache = options.embeddingCache;
        const semantic = config.vaultSemantic !== false && cache && Array.isArray(decision.queryEmbedding) && cache.model === decision.embedModel
          ? matchVaultSemantic(index, cache, decision.queryEmbedding, { projectId, mentionedProjects })
          : null;
        if (semantic && semantic.candidates >= MIN_SEMANTIC_CANDIDATES) {
          applySemanticMatch(decision, semantic, projectId, route);
        } else {
          applyWordMatch(decision, matchVault(index, text, { projectId }), projectId, route);
        }
      }
    } catch {}
  }

  return finishEnrichment(decision, text, turn, config, options, { now, env, route, noContext, originalAction, projectId });
}

// Retriever verdict. Measured with the trained recall head on real prompts plus the Vault question
// set: "recall when the head says so OR one note stands out; skip only when the head is low AND no
// note stands out" removed every wrong skip and raised recall from 86% to 98%, at 83% of the
// unrelated prompts still skipped. So a strong match overrides a model skip, a weak match only
// blocks it, and matched note paths ride along on every hint.
function applySemanticMatch(decision, semantic, projectId, route) {
  decision.vault = { mode: "semantic", strength: semantic.strength, prominence: semantic.prominence, top: semantic.top, candidates: semantic.candidates, projectId };
  if (decision.trace) { decision.trace.vault = semantic.strength; decision.trace.vaultMode = "semantic"; }
  if (semantic.hits.length === 0) return;
  decision.relatedNotes = semantic.hits.map((h) => h.path);
  const hitScope = semantic.hits[0].projectId === "global" ? "global" : "project";
  // A capture keeps its hint; the matched notes ride along as duplicate/update candidates.
  const isCapture = decision.memoryAction === "capture";
  void route;
  if (semantic.strength === "strong" && decision.memoryAction !== "recall" && !isCapture) {
    setAction(decision, "recall", "vault_match_strong");
    decision.scope = hitScope;
  } else if (semantic.strength === "weak" && decision.memoryAction === "skip") {
    setAction(decision, "default", "vault_match_weak");
  }
}

function applyWordMatch(decision, match, projectId, route) {
  decision.vault = { mode: "words", strength: match.strength, topScore: match.topScore, projectId };
  if (decision.trace) { decision.trace.vault = match.strength; decision.trace.vaultMode = "words"; }
  if (match.hits.length > 0) {
    decision.relatedNotes = match.hits.map((h) => h.path);
    const hitScope = match.hits[0].projectId === "global" ? "global" : "project";
    // Word overlap with a note is weak evidence on its own: measured on real prompts, most
    // project tasks share words with some note, so a match alone as a recall trigger was right
    // only ~1 time in 10. It therefore only tips turns the judge was unsure about: a strong match
    // turns "default" (or a model-suggested capture) into recall, any match keeps a turn from
    // being skipped, and a confident decision stands (with the notes attached).
    const explicitCapture = decision.memoryAction === "capture" && route === "fast_path";
    const uncertain = decision.memoryAction === "default" || (decision.memoryAction === "capture" && !explicitCapture);
    if (match.strength === "strong" && uncertain) {
      setAction(decision, "recall", "vault_match_strong");
      decision.scope = hitScope;
    } else if (decision.memoryAction === "skip") {
      setAction(decision, "default", match.strength === "strong" ? "vault_match_strong" : "vault_match_weak");
    }
  }
}

// A reminder must reach the model, so a turn that carries one is never a compact "skip" turn.
function memoryActionAfterFollowUp(decision) {
  return decision.memoryAction === "skip" ? "default" : decision.memoryAction;
}

function finishEnrichment(decision, text, turn, config, options, { now, env, route, noContext, originalAction, projectId }) {
  // 2. Session continuity
  const statePath = options.sessionStatePath ?? defaultSessionStatePath();
  let state = null;
  let prev = null;
  const sessionId = turn.sessionKey ? hashKey(`${turn.host ?? "host"}:${turn.sessionKey}`) : null;
  if (sessionId) {
    state = readJson(statePath);
    if (!state || typeof state !== "object" || typeof state.sessions !== "object") state = { sessions: {} };
    prev = state.sessions[sessionId] ?? null;
    if (prev && now - prev.at > SESSION_TTL_MS) prev = null;
    if (prev && !noContext && prev.action === "recall" && now - prev.at <= CONTINUITY_WINDOW_MS) {
      if (decision.memoryAction === "default") {
        setAction(decision, "recall", "session_continuity");
        if (!decision.relatedNotes && Array.isArray(prev.notes) && prev.notes.length) decision.relatedNotes = prev.notes.slice(0, 3);
      } else if (decision.memoryAction === "skip" && typeof text === "string" && text.trim().length <= 40 && FOLLOW_UP.test(text.trim())) {
        setAction(decision, "default", "session_continuity");
      }
    }
    // 2b. Proactive-capture follow-ups from the previous turn.
    if (prev && !noContext && now - prev.at <= ENFORCE_WINDOW_MS) {
      const capture = prev.capture;
      // Not when the request already went to the digest (enqueueTurnEnd): the digest stages it.
      if (capture && capture.kind === "explicit" && !capture.reminded && !capture.queued && decision.memoryAction !== "capture" && !stagedSince(capture)) {
        decision.captureCarryOver = { text: capture.text };
        capture.reminded = true;
      }
      if (prev.debugging && config?.proactiveCapture !== false && typeof text === "string" && SOLVED.test(text.trim()) && decision.memoryAction !== "capture") {
        if (autoCaptureMode(config) === "digest") {
          enqueueCapture("solved", { prompt: text }, { ...turn, projectId }, { ...(options.queueDir ? { queueDir: options.queueDir } : {}), now });
        } else if (autoCaptureMode(config) !== "off") {
          decision.pitfallCheck = true;
        }
      }
      // "remind" mode of the end-of-turn check: the previous reply looked worth keeping and nothing was staged.
      if (prev.turnEnd?.remind && prev.inbox && !stagedSince(prev.inbox) && decision.memoryAction !== "capture") {
        decision.turnEndReminder = true;
        prev.turnEnd.remind = false;
      }
      if (decision.captureCarryOver || decision.pitfallCheck || decision.turnEndReminder) {
        decision.memoryAction = memoryActionAfterFollowUp(decision);
        decision.boost = decision.boost ?? (decision.captureCarryOver ? "capture_carry_over" : (decision.pitfallCheck ? "pitfall_check" : "turn_end_reminder"));
        if (decision.trace) decision.trace.boost = decision.boost;
      }
    }
  }

  // 3. Decision log (+ suspected misses)
  let logId = null;
  const logPath = options.decisionLogPath ?? (config.serviceFile ? defaultDecisionLogPath(config.serviceFile) : null);
  // Only real host adapters (turn.host) log; offline tools such as eval pass no host.
  if (logPath && turn.host && !logDisabled(config, env)) {
    logId = crypto.randomBytes(6).toString("hex");
    const sensitive = decision.reason === "sensitive_content";
    appendDecisionLog(logPath, {
      id: logId,
      ts: new Date(now).toISOString(),
      host: turn.host ?? null,
      session: sessionId,
      text: sensitive ? null : String(text ?? "").slice(0, LOG_TEXT_CHARS),
      route: route ?? null,
      reason: decision.reason ?? null,
      score: typeof decision.score === "number" ? Math.round(decision.score * 1000) / 1000 : null,
      laya: originalAction,
      action: decision.memoryAction,
      boost: decision.boost ?? null,
      vault: decision.vault?.strength ?? null,
      vaultMode: decision.vault?.mode ?? null,
      ...(decision.captureKind ? { captureKind: decision.captureKind } : {}),
      ...(typeof decision.durableScore === "number" ? { durable: Math.round(decision.durableScore * 1000) / 1000 } : {}),
      notes: decision.relatedNotes ?? [],
      // Why a Laya call failed (timeout, connection refused ...): the only trace a host's debug-level log hides.
      ...(typeof decision.error === "string" && decision.error ? { error: redactSecrets(decision.error).text.slice(0, 200) } : {})
    });
    // Asking about the past right after a turn that was skipped suggests that turn was a miss.
    if (prev?.logId && route === "fast_path" && decision.reason === "explicit_recall_intent" &&
        (prev.action === "skip" || prev.action === "default") && now - prev.at <= SUSPECT_WINDOW_MS) {
      appendDecisionLog(logPath, { type: "suspect", ref: prev.logId, by: logId, ts: new Date(now).toISOString() });
    }
  }

  // "digest": a lasting statement goes to the capture queue instead of a hint (see router.js).
  // The wording backs up the durable head (personal facts score low there). An explicit "记住" is staged
  // by the agent in this turn, so it is not queued a second time.
  const explicitSave = decision.memoryAction === "capture" && decision.captureKind !== "durable";
  const durableByWording = !decision.durableCandidate && config?.proactiveCapture !== false && looksLikeDurableStatement(text);
  if ((decision.durableCandidate || durableByWording) && !explicitSave && autoCaptureMode(config) === "digest" && turn.host && !noContext) {
    enqueueCapture("statement", { prompt: text, score: decision.durableScore ?? null }, { ...turn, projectId }, { ...(options.queueDir ? { queueDir: options.queueDir } : {}), now });
  }
  const digestOn = turn.host && autoCaptureMode(config) === "digest" && config?.proactiveCapture !== false;
  if (digestOn && !digestSpawnDisabled(env)) {
    (options.scheduleDigest ?? maybeScheduleDigest)({ ...(options.queueDir ? { queueDir: options.queueDir } : {}), env });
  }
  // Tell the user (once per batch) what the background digest staged or holds since the last conversation.
  if (digestOn && !noContext) {
    const staged = (options.takeStaged ?? takeStagedSinceNotice)({ now });
    if (staged) decision.digestStaged = staged;
  }

  if (sessionId && state) {
    const snippet = typeof text === "string" && decision.reason !== "sensitive_content" ? text.trim().slice(0, STATE_TEXT_CHARS) : null;
    const fullPrompt = typeof text === "string" && decision.reason !== "sensitive_content" ? redactSecrets(text.trim()).text.slice(0, PROMPT_STATE_CHARS) : null;
    const scope = inboxScope(turn.vaultPath, projectId);
    const base = scope.dirs.length ? inboxBaseline(scope.dirs) : {};
    let capture = null;
    if (decision.memoryAction === "capture" && snippet) {
      capture = { kind: decision.captureKind === "durable" ? "durable" : "explicit", text: snippet, at: now, dirs: scope.dirs, target: scope.target, base, enforced: false, reminded: false };
    } else if (prev?.capture && prev.capture.kind === "explicit" && !prev.capture.reminded) {
      capture = prev.capture; // keep an unreminded explicit request until its turn comes
    }
    state.sessions[sessionId] = {
      action: decision.memoryAction,
      at: now,
      ...(decision.relatedNotes ? { notes: decision.relatedNotes.slice(0, 3) } : {}),
      ...(logId ? { logId } : {}),
      ...(capture ? { capture } : {}),
      ...(scope.dirs.length ? { inbox: { dirs: scope.dirs, base, target: scope.target } } : {}),
      ...(fullPrompt ? { prompt: fullPrompt } : {}),
      turn: { vaultPath: turn.vaultPath ?? null, projectId: projectId ?? null, cwd: turn.cwd ?? null },
      ...(snippet && DEBUGGING.test(snippet) ? { debugging: true } : {})
    };
    const entries = Object.entries(state.sessions).filter(([, v]) => v && now - v.at <= SESSION_TTL_MS);
    entries.sort((a, b) => b[1].at - a[1].at);
    state.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
    writeJsonAtomic(statePath, state);
  }
  return decision;
}
