/**
 * Per-turn context around a routing decision:
 *   1. Vault hints: upgrade the action when the Vault holds matching notes (and name them).
 *   2. Session continuity: a follow-up right after a recall keeps recalling.
 *   3. Decision log: a private local JSONL of decisions, for `npm run laya:label`, plus
 *      "suspected miss" flags when the user asks about the past right after a skipped turn.
 * Everything here is best-effort: any failure leaves the decision unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDefaultCacheDir } from "./cache.js";
import { loadVaultIndex, matchVault, resolveProjectIdFromCwd, defaultIndexCachePath } from "./vault-index.js";
import { isGenericQuestion } from "./fast-path.js";

const SESSION_TTL_MS = 60 * 60 * 1000;
const CONTINUITY_WINDOW_MS = 20 * 60 * 1000;
const SUSPECT_WINDOW_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_TEXT_CHARS = 500;
const NO_CONTEXT_FAST_PATH = new Set(["trivial_greeting", "sensitive_content", "empty_text"]);

// Short follow-ups that only make sense with the previous turn ("继续", "那这个呢", "also do X").
const FOLLOW_UP = /^(?:(?:那|这|还有|再|继续|接着|然后|同样|也|顺便|另外|那个|这个)|(?:and|also|then|same|continue|what about|how about)\b)/iu;

export function defaultSessionStatePath(options = {}) {
  return path.join(getDefaultCacheDir(options), "session-state.json");
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

const hashKey = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

function logDisabled(config, env) {
  const flag = env?.OBSIDIAN_MEMORY_DECISION_LOG?.trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return true;
  return config.decisionLog === false;
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
 * options: { env, now, indexCachePath, sessionStatePath, decisionLogPath }
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
      const index = loadVaultIndex(turn.vaultPath, { cachePath: options.indexCachePath ?? defaultIndexCachePath(), now });
      if (index) {
        projectId = projectId ?? resolveProjectIdFromCwd(turn.vaultPath, turn.cwd);
        const match = matchVault(index, text, { projectId });
        decision.vault = { strength: match.strength, topScore: match.topScore, projectId };
        if (decision.trace) decision.trace.vault = match.strength;
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
    } catch {}
  }

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
      notes: decision.relatedNotes ?? []
    });
    // Asking about the past right after a turn that was skipped suggests that turn was a miss.
    if (prev?.logId && route === "fast_path" && decision.reason === "explicit_recall_intent" &&
        (prev.action === "skip" || prev.action === "default") && now - prev.at <= SUSPECT_WINDOW_MS) {
      appendDecisionLog(logPath, { type: "suspect", ref: prev.logId, by: logId, ts: new Date(now).toISOString() });
    }
  }

  if (sessionId && state) {
    state.sessions[sessionId] = {
      action: decision.memoryAction,
      at: now,
      ...(decision.relatedNotes ? { notes: decision.relatedNotes.slice(0, 3) } : {}),
      ...(logId ? { logId } : {})
    };
    const entries = Object.entries(state.sessions).filter(([, v]) => v && now - v.at <= SESSION_TTL_MS);
    entries.sort((a, b) => b[1].at - a[1].at);
    state.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
    writeJsonAtomic(statePath, state);
  }
  return decision;
}
