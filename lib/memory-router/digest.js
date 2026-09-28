/**
 * Session digest: the asynchronous half of automatic capture.
 *
 * Runs outside any host turn (spawned in the background by a hook when a session has gone idle, or
 * by `laya digest`). For each idle session queue (capture-queue.js) it keeps the turns that concluded
 * something, merges consecutive turns about the same topic, takes each topic's LAST conclusion (earlier
 * ones in a debugging session are often revised), and writes at most a couple of pending-ingest Inbox
 * candidates per session. The obsidian-memory skill's hard rules for writing a candidate are enforced
 * here in code rather than left to a model: an initialized Vault, a resolved project scope (never Global
 * by default), the project's opt-out, no credentials, no duplicate of a pending auto candidate, the
 * Vault's own candidate template and the cand-<uuid> id rule. Candidates are verbatim evidence marked
 * `origin: auto-digest`; synthesis happens later at ingest, which the user starts.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateDir as layaStateDir, digestLogFile } from "./paths.js";
import { defaultQueueDir, listQueue, claimSession, readSessionRecords, hashKey, hasStrongConclusion } from "./capture-queue.js";
import { nextTranscriptDelay } from "./transcripts.js";
import { detectScope, containsSensitiveContent, isGenericQuestion } from "./fast-path.js";
import {
  loadVaultIndex, loadEmbeddingCache, ensureVaultEmbeddings, matchVaultSemantic, resolveProjectIdFromCwd,
  defaultIndexCachePath, defaultEmbeddingCachePath
} from "./vault-index.js";

export const DIGEST_IDLE_MS = 20 * 60 * 1000;
export const DIGEST_MIN_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const STALE_QUEUE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOPICS_PER_SESSION = 2;
const MAX_STATEMENTS_PER_SESSION = 2;
// Explicit requests are the user's own words: every one is kept (a runaway session is still bounded).
const MAX_EXPLICIT_PER_SESSION = 5;
const HELD_DIR = "held";
const HELD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNAL_KEYWORDS = 2;
const SIGNAL_LAYA_SCORE = 0.5;
// Replies about the same topic under the retriever (multilingual-e5-small cosines are compressed into
// roughly 0.75-0.95). On hand-written conclusion pairs (2026-09-28, not real traffic yet) a revised
// conclusion on the same problem scored 0.907-0.937 and different problems of one project 0.85-0.911:
// 0.91 merges 9/10 revisions and 1/66 unrelated pairs (0.88 merged 38/66, dropping earlier findings).
// Without the retriever a session is one topic.
const SAME_TOPIC_COSINE = 0.91;
// Semantic near-duplicates of an earlier auto-digest candidate; identical wording is caught by
// source_hash before this (the vectors of a note and of a reply differ: identical text scored 0.944).
const NEAR_DUPLICATE_COSINE = 0.95;
// Outcomes that may succeed on a later run: the queue is kept.
const RETRYABLE = new Set(["vault_unreadable"]);
const WAITER_STARTUP_MS = 60 * 1000;
const WAITER_FILE = "digest-waiter.json";
const BUNDLED_TEMPLATE = fileURLToPath(new URL("../../skills/obsidian-memory/assets/templates/inbox-memory-candidate.md", import.meta.url));
const DIGEST_SCRIPT = fileURLToPath(new URL("../../scripts/memory-digest.mjs", import.meta.url));

// A project (or the whole Vault) can opt out of automatic candidates in its AGENTS.md or rules.md.
const OPT_OUT = /no-auto-capture|auto-capture:\s*off|do not auto-capture|recall only|禁止自动(?:记录|暂存|写入|捕获)|不要自动(?:记录|暂存|写入)|只召回/iu;

export function digestStateDir(options = {}) {
  return layaStateDir(options);
}

function readText(file, max = 65536) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {}
}

function appendLog(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch {}
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Physical inbox directory of a scope inside the Vault, or { error }. Never creates project structure. */
export function resolveInbox(vaultPath, scope, projectId) {
  let root;
  try { root = fs.realpathSync(vaultPath); } catch { return { error: "vault_unreadable" }; }
  if (!fs.existsSync(path.join(root, "AGENTS.md")) || !fs.existsSync(path.join(root, "00-System"))) return { error: "vault_not_initialized" };
  if (OPT_OUT.test(readText(path.join(root, "AGENTS.md")))) return { error: "vault_opt_out" };
  let dir;
  if (scope === "global") {
    dir = path.join(root, "10-Global", "inbox");
  } else {
    if (!projectId) return { error: "no_project" };
    const projectDir = path.join(root, "20-Projects", projectId);
    if (!fs.existsSync(projectDir)) return { error: "project_not_bound" };
    if (OPT_OUT.test(readText(path.join(projectDir, "AGENTS.md"))) || OPT_OUT.test(readText(path.join(projectDir, "rules.md")))) return { error: "project_opt_out" };
    dir = path.join(projectDir, "inbox");
  }
  let real;
  try { real = fs.realpathSync(dir); } catch { return { error: "no_inbox" }; }
  if (!isInside(root, real) || !fs.statSync(real).isDirectory()) return { error: "inbox_outside_vault" };
  return { root, dir: real, rel: path.relative(root, real).split(path.sep).join("/") };
}

function inboxHasHash(dir, hash) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return false; }
  const needle = new RegExp(`^source_hash:\\s*"?${hash}"?\\s*$`, "mu");
  return names.some((name) => name.endsWith(".md") && needle.test(readText(path.join(dir, name), 4096) ?? ""));
}

function blockquote(text) {
  return String(text).trim().split(/\r?\n/u).map((l) => `> ${l}`.trimEnd()).join("\n");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? "")).slice(1, -1);
}

// A request like "继续" or "好的" says nothing about the finding; the conclusion's first line does.
const UNINFORMATIVE = /^(?:继续|接着|好的?|可以了?|行|嗯|对|是的|没问题|ok|okay|yes|go on|continue|next|然后呢)[\s，。!！,.?？]*$/iu;

function candidateTitle(item) {
  const prompt = String(item.prompt ?? "").trim();
  if (item.kind !== "turn") return titleFrom(prompt);
  const informative = prompt.replace(/\s+/gu, "").length >= 6 && !UNINFORMATIVE.test(prompt);
  return titleFrom(informative ? prompt : item.reply);
}

function titleFrom(text, fallback) {
  const line = String(text || "").split(/\r?\n/u).map((l) => l.trim()).find((l) => l && !/^#|^```/u.test(l)) || fallback || "Auto-digested finding";
  const plain = line.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/[`*_>#]/gu, "").replace(/\s+/gu, " ").trim();
  return plain.length > 60 ? `${plain.slice(0, 59)}…` : plain;
}

/**
 * The Vault's own candidate template when it has one, else the bundled template. Both placeholder styles
 * are understood: "{{title}}" (the bundled template) and "<Memory candidate title>" (hand-written ones).
 */
export function candidateTemplate(vaultRoot) {
  const own = (readText(path.join(vaultRoot, "00-System", "templates", "inbox-memory-candidate.md")) ?? "").replace(/\r\n?/gu, "\n");
  if (own && /^---\n[\s\S]*?\n---/u.test(own) && (/\{\{\s*(?:candidate_id|id|title)\s*\}\}/u.test(own) || /^title:\s*<[^>\n]*>\s*$/mu.test(own))) {
    return { text: own, source: "vault" };
  }
  return { text: readText(BUNDLED_TEMPLATE).replace(/\r\n?/gu, "\n"), source: "bundled" };
}

// Section headings a template may use for each part of the candidate (bundled names first).
const SECTIONS = {
  evidence: ["Original evidence", "Candidate evidence", "Evidence"],
  context: ["Capture context and reason to retain", "Capture context", "Context"],
  source: ["Source reference", "Source"],
  related: ["Related canonical notes", "Related notes", "Related"]
};

function headingRe(heading) {
  return new RegExp(`^##[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[ \\t]*$`, "mu");
}

// Put content under the first heading of `names` the body has (replacing a "<…>" placeholder paragraph),
// or append a section with the first name when `always` and none exists.
function fillSection(body, names, content, always = true) {
  for (const heading of names) {
    const re = headingRe(heading);
    const m = re.exec(body);
    if (!m) continue;
    const after = body.slice(m.index + m[0].length);
    const next = after.search(/^##?[ \t]/mu);
    const section = next === -1 ? after : after.slice(0, next);
    const rest = next === -1 ? "" : after.slice(next);
    const kept = section.split("\n").filter((l) => !/^\s*<[^>\n]*>\s*$/u.test(l)).join("\n").trim();
    return `${body.slice(0, m.index)}${m[0]}\n\n${content}${kept ? `\n\n${kept}` : ""}\n\n${rest}`.replace(/\n{3,}/gu, "\n\n");
  }
  return always ? `${body.trimEnd()}\n\n## ${names[0]}\n\n${content}\n` : body;
}

// The value for a frontmatter key whose template value is a "<…>" or "YYYY-MM-DD" placeholder.
function placeholderValue(key, raw, fields) {
  const options = raw.replace(/^<|>$/gu, "").split("|").map((o) => o.trim()).filter(Boolean);
  switch (key) {
    case "title": return `"${yamlString(fields.title)}"`;
    case "captured": case "created": case "date": return fields.created.slice(0, 10);
    case "project_id": return fields.projectId ? `"${yamlString(fields.projectId)}"` : (fields.scope === "global" ? "global" : "null");
    case "scope": return fields.scope;
    case "origin": return `"${yamlString(fields.meta.origin ?? options[0] ?? "")}"`;
    case "source_ref": case "source": return `"${yamlString(fields.sourceRef)}"`;
    default: return options.length === 1 && /\s/u.test(options[0]) ? '""' : (options[0] ?? '""');
  }
}

export function renderCandidate(template, fields) {
  let text = String(template).replace(/\r\n?/gu, "\n")
    .replace(/\{\{\s*(?:candidate_id|id)\s*\}\}/gu, fields.id)
    .replace(/\{\{\s*title\s*\}\}/gu, yamlString(fields.title))
    .replace(/\{\{\s*scope\s*\}\}/gu, fields.scope)
    .replace(/\{\{\s*created\s*\}\}/gu, fields.created)
    .replace(/\{\{\s*source_ref\s*\}\}/gu, yamlString(fields.sourceRef))
    .replace(/\{\{\s*project_id\s*\}\}/gu, fields.projectId ?? "");
  text = text.replace(/^project_id:\s*null\s*$/mu, fields.projectId ? `project_id: "${yamlString(fields.projectId)}"` : "project_id: null");
  const split = text.indexOf("\n---", 3);
  let head = text.slice(0, split);
  let body = text.slice(split + 4);
  // "<…>" placeholders in the frontmatter, then the provenance keys (replacing a key the template has).
  head = head.split("\n").map((line) => {
    const m = /^([A-Za-z_][\w-]*):\s*(<[^>\n]*>|YYYY-MM-DD)\s*$/u.exec(line);
    return m ? `${m[1]}: ${placeholderValue(m[1], m[2], fields)}` : line;
  }).join("\n");
  for (const [k, v] of Object.entries(fields.meta)) {
    const value = typeof v === "number" ? v : `"${yamlString(v)}"`;
    const re = new RegExp(`^${k}:.*$`, "mu");
    head = re.test(head) ? head.replace(re, `${k}: ${value}`) : `${head}\n${k}: ${value}`;
  }
  // "# <Memory candidate title>" and any other title placeholder in the body.
  body = body.replace(/^(#[ \t]+)<[^>\n]*>[ \t]*$/mu, `$1${fields.title}`);
  body = fillSection(body, SECTIONS.evidence, fields.evidence);
  body = fillSection(body, SECTIONS.source, fields.sourceRef, false);
  body = fillSection(body, SECTIONS.context, fields.context);
  body = fillSection(body, SECTIONS.related, fields.related);
  return `${head}\n---${body}`.replace(/\s*$/u, "\n");
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/**
 * Pick what a session concluded. Returns { topics: [{ last, members, confirmed, signal }], statements }.
 * embed(texts) -> vectors|null groups replies by topic; score(text) -> number|null rescues replies
 * with few conclusion words.
 */
export async function selectSessionFindings(records, { embed = null, score = null } = {}) {
  const turns = records.filter((r) => r.t === "turn" && typeof r.reply === "string");
  const solvedAt = records.filter((r) => r.t === "solved").map((r) => r.ts);
  const signals = [];
  for (const [i, t] of turns.entries()) {
    // Already staged by the agent for an explicit "记住" in that turn.
    if (t.staged) continue;
    const next = turns[i + 1]?.ts ?? "￿";
    const confirmed = solvedAt.some((ts) => ts > t.ts && ts < next);
    // A general knowledge answer ("X 和 Y 的区别") is not this project's conclusion unless a fix was confirmed.
    if (!confirmed && isGenericQuestion(t.prompt ?? "")) continue;
    let laya = typeof t.score === "number" ? t.score : null;
    if (!(t.keywords >= SIGNAL_KEYWORDS && hasStrongConclusion(t.reply)) && !confirmed && laya === null && score) {
      try { laya = await score(t.reply); } catch { laya = null; }
    }
    const byWords = t.keywords >= SIGNAL_KEYWORDS && hasStrongConclusion(t.reply);
    if (byWords || confirmed || (laya !== null && laya >= SIGNAL_LAYA_SCORE)) {
      signals.push({ ...t, confirmed, laya });
    }
  }
  let vectors = null;
  if (embed && signals.length > 1) {
    try { vectors = await embed(signals.map((s) => s.reply)); } catch { vectors = null; }
  }
  const topics = [];
  for (const [i, s] of signals.entries()) {
    let home = null;
    if (vectors) {
      let best = -1;
      for (const topic of topics) {
        const sim = dot(vectors[i], vectors[topic.lastIndex]);
        if (sim > best) { best = sim; home = sim >= SAME_TOPIC_COSINE ? topic : null; }
      }
    } else if (topics.length) {
      home = topics[0];
    }
    if (home) {
      home.members++;
      home.last = s;
      home.lastIndex = i;
      home.confirmed = home.confirmed || s.confirmed;
    } else {
      topics.push({ last: s, lastIndex: i, members: 1, confirmed: s.confirmed });
    }
  }
  topics.sort((a, b) => (b.confirmed - a.confirmed) || (b.members - a.members) || b.last.ts.localeCompare(a.last.ts));
  const seen = new Set();
  const statements = records.filter((r) => r.t === "statement").filter((r) => {
    const key = r.prompt.replace(/\s+/gu, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Best statements first (a wording match has no score and counts as sure), then the latest.
  const ranked = statements.map((r, i) => ({ r, i, s: typeof r.score === "number" ? r.score : 1 }))
    .sort((a, b) => (b.s - a.s) || (b.i - a.i)).slice(0, MAX_STATEMENTS_PER_SESSION).sort((a, b) => a.i - b.i).map((x) => x.r);
  const seenExplicit = new Set();
  const explicit = records.filter((r) => r.t === "explicit" && typeof r.prompt === "string").filter((r) => {
    const key = r.prompt.replace(/\s+/gu, "");
    if (seenExplicit.has(key)) return false;
    seenExplicit.add(key);
    return true;
  }).slice(-MAX_EXPLICIT_PER_SESSION);
  return { topics: topics.slice(0, MAX_TOPICS_PER_SESSION), statements: ranked, explicit, signalTurns: signals.length, turns: turns.length };
}

// Wording that ties a statement to a codebase or project ("这个项目……", "this repo ……"), and wording about
// the user themselves, which the Skill files under Global ("always answer me in Chinese").
const PROJECT_WORDING = /这个项目|本项目|该项目|项目里|项目中|项目的|仓库|代码库|代码里|这个(?:仓库|库|服务|应用|app)|\b(?:this|our|the) (?:project|repo|repository|codebase|service|app)\b/iu;
const PERSONAL_WORDING = /我(?:对.{1,12}过敏|不吃|不喝|吃素|喜欢|偏好|习惯|讨厌|的(?:目标|偏好|习惯|饮食|作息|时区|名字|生日|身高|体重))|(?:回复|回答|称呼)我|(?:给我|跟我|对我)(?:回复|回答|说话)|\b(?:I am|I'm|my (?:name|goal|preference|timezone)|call me|answer me|reply to me)\b/iu;

/**
 * Where a finding goes: "project" (the session's resolved project), "global" (a user-wide preference or
 * fact about the user, which the Skill files under Global even inside a project), or "hold" (the scope is
 * unresolved: kept outside the Vault until the user decides, as the Skill requires: "If only one scope is
 * unresolved, hold that part"). A session conclusion is never guessed into Global.
 */
export function findingScope(kind, text, projectId) {
  const t = String(text ?? "");
  if (kind !== "turn") {
    if (detectScope(t) === "global") return "global";
    if (PERSONAL_WORDING.test(t) && !PROJECT_WORDING.test(t)) return "global";
  }
  return projectId ? "project" : "hold";
}

function findingText(item) {
  return item.kind === "turn" ? item.reply : item.prompt;
}

function evidenceFor(item) {
  if (item.kind === "turn") {
    return [
      `- Request (user; turn finished ${item.ts}):`, "", blockquote(item.prompt || "(not recorded)"), "",
      "- Final conclusion (agent, verbatim):", "", blockquote(item.reply), "",
      ...(item.members > 1 ? [`- This topic ran over ${item.members} concluding turns in the session; this is the last one (earlier conclusions may have been revised).`] : []),
      ...(item.confirmed ? ["- The user then reported the problem as solved."] : [])
    ].join("\n");
  }
  if (item.kind === "explicit") {
    return [
      `- The user asked to remember this (${item.ts}):`, "", blockquote(item.prompt), "",
      ...(item.reply ? ["- Agent reply in that turn (verbatim):", "", blockquote(item.reply)] : [])
    ].join("\n");
  }
  return [`- User statement (said ${item.ts}):`, "", blockquote(item.prompt)].join("\n");
}

function contextFor(item, host) {
  if (item.kind === "explicit") {
    return `The user explicitly asked to remember this in a ${host} session, and the turn ended without a staged candidate; the Obsidian Memory session digest staged the request as a backstop. ` +
      "Verify the wording before ingest.";
  }
  const why = item.kind === "turn"
    ? `signal: ${item.keywords} conclusion words${item.laya !== null && item.laya !== undefined ? `, Laya capture score ${item.laya}` : ""}${item.confirmed ? ", confirmed fix" : ""}`
    : `signal: ${typeof item.score === "number" ? `Laya durable-statement score ${item.score}` : "lasting-rule wording"}`;
  return `Staged automatically by the Obsidian Memory session digest after a ${host} session went idle (${why}). ` +
    "Nobody has reviewed it yet: verify it before ingest, and delete it if it turns out routine or wrong.";
}

const AUTO_KIND = { turn: "session-conclusion", statement: "user-statement", explicit: "explicit-request" };

/**
 * Render and write one candidate into a resolved inbox. Enforces the last checks (credentials in the final
 * text, identical wording already pending, path inside the Vault). Returns { path, template } or { skip }.
 */
function writeCandidate({ item, inbox, scope, projectId, host, session, textHash, related = [], now, dryRun }) {
  const id = `cand-${crypto.randomUUID()}`;
  const created = new Date(now).toISOString();
  const relatedText = related.length ? related.map((p) => `- [[${p.replace(/\.md$/u, "")}]]`).join("\n") : "- None found automatically.";
  const template = candidateTemplate(inbox.root);
  const content = renderCandidate(template.text, {
    id, title: candidateTitle(item), scope, created,
    sourceRef: `${host} session ${session}, digested ${created.slice(0, 10)}`,
    projectId: scope === "project" ? projectId : null,
    evidence: evidenceFor(item), context: contextFor(item, host), related: relatedText,
    meta: { origin: "auto-digest", source_host: host, source_session: session, source_hash: textHash, auto_kind: AUTO_KIND[item.kind] }
  });
  // Last line of defence: the final text is scanned again, and a hit is not written.
  if (containsSensitiveContent(content)) return { skip: "sensitive_content" };
  const file = path.join(inbox.dir, `${id}.md`);
  if (!isInside(inbox.root, file)) return { skip: "path_escape" };
  if (!dryRun) fs.writeFileSync(file, content, { flag: "wx", mode: 0o644 });
  return { path: `${inbox.rel}/${id}.md`, template: template.source };
}

// ---------------------------------------------------------------- held findings (scope unresolved)

function heldDir(stateDir) {
  return path.join(stateDir, HELD_DIR);
}

/** Keep a finding whose scope is unresolved outside the Vault. Returns its id, or null (duplicate/failure). */
export function holdFinding({ stateDir = digestStateDir(), item, host, session, vaultPath, cwd = null, textHash, now = Date.now() }) {
  try {
    const dir = heldDir(stateDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(dir)) {
      if (readJson(path.join(dir, name))?.textHash === textHash) return null;
    }
    const id = `held-${crypto.randomUUID().slice(0, 8)}`;
    const record = { id, heldAt: new Date(now).toISOString(), host, session, vaultPath, cwd, textHash, item };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return id;
  } catch {
    return null;
  }
}

/** Held findings, oldest first; ones older than 30 days are dropped (and logged). */
export function listHeld({ stateDir = digestStateDir(), logPath = null, now = Date.now() } = {}) {
  const dir = heldDir(stateDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^held-[0-9a-f]{8}\.json$/u.test(n)); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const held = readJson(file);
    if (!held?.item) { try { fs.unlinkSync(file); } catch {} continue; }
    if (now - Date.parse(held.heldAt) > HELD_TTL_MS) {
      try { fs.unlinkSync(file); } catch {}
      if (logPath) appendLog(logPath, { ts: new Date(now).toISOString(), held: held.id, action: "expired" });
      continue;
    }
    out.push(held);
  }
  return out.sort((a, b) => a.heldAt.localeCompare(b.heldAt));
}

/**
 * File a held finding: into a project's inbox (`projectId`) or Global (`global: true`), with the same rules
 * as the digest. Returns { path } or { error }.
 */
export function fileHeld(id, { projectId = null, global = false, stateDir = digestStateDir(), logPath = digestLogFile(), vaultPath = null, now = Date.now() } = {}) {
  const file = path.join(heldDir(stateDir), `${String(id).replace(/[^\w-]/gu, "")}.json`);
  const held = readJson(file);
  if (!held?.item) return { error: "not_found" };
  if (!global && !projectId) return { error: "no_scope" };
  const vault = vaultPath ?? held.vaultPath;
  if (!vault) return { error: "no_vault" };
  const scope = global ? "global" : "project";
  const inbox = resolveInbox(vault, scope, projectId);
  if (inbox.error) return { error: inbox.error };
  if (inboxHasHash(inbox.dir, held.textHash)) {
    try { fs.unlinkSync(file); } catch {}
    return { error: "duplicate" };
  }
  const out = writeCandidate({ item: held.item, inbox, scope, projectId, host: held.host, session: held.session, textHash: held.textHash, now, dryRun: false });
  if (out.skip) return { error: out.skip };
  try { fs.unlinkSync(file); } catch {}
  appendLog(logPath, { ts: new Date(now).toISOString(), held: held.id, action: "filed", vaultPath: vault, projectId: scope === "project" ? projectId : null, written: [out.path], skipped: [] });
  return { path: out.path };
}

/** Drop a held finding at the user's request. */
export function discardHeld(id, { stateDir = digestStateDir(), logPath = digestLogFile(), now = Date.now() } = {}) {
  const file = path.join(heldDir(stateDir), `${String(id).replace(/[^\w-]/gu, "")}.json`);
  try {
    fs.unlinkSync(file);
    appendLog(logPath, { ts: new Date(now).toISOString(), held: id, action: "discarded" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- digest run

/**
 * Process idle session queues. options:
 *   queueDir, stateDir, now, idleMs, force (ignore idleness), dryRun, sessions (ids to limit to),
 *   readySessions (ids to treat as idle, e.g. just collected from a transcript),
 *   score(text) -> number|null, embed(texts, kind) -> { model, vectors }|null,
 *   indexCachePath, embeddingCachePath.
 * Returns { processed, written: [{ session, path, kind }], held: [{ session, id }], skipped: [{ session, reason }] }.
 */
export async function runDigest(options = {}) {
  const now = options.now ?? Date.now();
  const queueDir = options.queueDir ?? defaultQueueDir();
  const stateDir = options.stateDir ?? digestStateDir();
  const idleMs = options.force ? 0 : (options.idleMs ?? DIGEST_IDLE_MS);
  // ~/.laya/digest-log.jsonl, next to decisions.jsonl (a test passing its own stateDir keeps the log there).
  const logPath = options.logPath ?? (options.stateDir ? path.join(options.stateDir, "digest-log.jsonl") : digestLogFile());
  const doneFile = path.join(stateDir, "digest-done.json");
  const done = readJson(doneFile) ?? {};
  const summary = { processed: 0, written: [], held: [], skipped: [] };
  const embedPassages = options.embed ? (texts) => options.embed(texts, "passage") : null;
  const embedQuery = options.embed ? async (texts) => (await options.embed(texts, "query"))?.vectors ?? null : null;
  const ready = new Set(options.readySessions ?? []);
  listHeld({ stateDir, logPath, now });

  for (const entry of listQueue(queueDir)) {
    if (options.sessions && !options.sessions.includes(entry.session)) continue;
    // A queue older than 7 days is still digested first; it is only dropped when that run cannot finish.
    const stale = now - entry.mtimeMs > STALE_QUEUE_MS;
    if (!options.force && !stale && !ready.has(entry.session) && now - entry.mtimeMs < idleMs) continue;
    // Claim before reading: a turn that ends meanwhile goes to a new live file, not into this run.
    const files = options.dryRun ? entry.files : claimSession(entry, { now });
    const records = readSessionRecords(files);
    summary.processed++;
    const written = [];
    const held = [];
    const skipped = [];
    let findings = null;
    let host = "host";
    let projectId = null;
    let vaultPath = null;
    try {
      const latest = [...records].reverse();
      vaultPath = latest.find((r) => r.vaultPath)?.vaultPath ?? null;
      host = latest.find((r) => r.host)?.host ?? "host";
      projectId = latest.find((r) => r.projectId)?.projectId ?? null;
      const cwd = latest.find((r) => r.cwd)?.cwd ?? null;
      if (!projectId && vaultPath && cwd) projectId = resolveProjectIdFromCwd(vaultPath, cwd);
      findings = await selectSessionFindings(records, { embed: embedQuery, score: options.score ?? null });
      const items = [
        ...findings.explicit.map((r) => ({ kind: "explicit", prompt: r.prompt, reply: r.reply ?? "", ts: r.ts, redacted: r.redacted })),
        ...findings.topics.map((topic) => ({ kind: "turn", prompt: topic.last.prompt, reply: topic.last.reply, ts: topic.last.ts, keywords: topic.last.keywords, laya: topic.last.laya ?? null, members: topic.members, confirmed: topic.confirmed, redacted: topic.last.redacted })),
        ...findings.statements.map((st) => ({ kind: "statement", prompt: st.prompt, ts: st.ts, score: st.score ?? null, redacted: st.redacted }))
      ];
      // An unreadable Vault (unmounted, syncing) also hides the project: retry later rather than hold.
      const vaultReadable = Boolean(vaultPath) && fs.existsSync(vaultPath);
      if (!vaultPath) skipped.push("no_vault");
      else if (!vaultReadable) skipped.push("vault_unreadable");
      else if (items.length === 0) skipped.push("no_findings");

      // Vault notes for related links and near-duplicate checks (retriever, best-effort).
      let index = null;
      let cache = null;
      if (vaultReadable && items.length && embedPassages) {
        try {
          index = loadVaultIndex(vaultPath, { cachePath: options.indexCachePath ?? defaultIndexCachePath(), now });
          const probe = await embedPassages(["probe"]);
          if (index && probe?.model) {
            const cachePath = options.embeddingCachePath ?? defaultEmbeddingCachePath();
            cache = loadEmbeddingCache(cachePath, { vaultPath, model: probe.model });
            await ensureVaultEmbeddings(index, cache, async (texts) => (await embedPassages(texts))?.vectors ?? [], { cachePath, maxNotes: 256 });
          }
        } catch { cache = null; }
      }

      for (const item of (vaultReadable ? items : [])) {
        const text = findingText(item);
        const sourceHash = hashKey(`${item.kind}:${text}`);
        if ((done[entry.session] ?? []).includes(sourceHash)) { skipped.push("already_digested"); continue; }
        // Credentials were redacted when queued; a finding that contained one is not written at all.
        if (item.redacted) { skipped.push("sensitive_content"); continue; }
        // The same wording (whitespace aside) from another session is the same finding.
        const textHash = hashKey(text.replace(/\s+/gu, ""));
        const scope = findingScope(item.kind, text, projectId);
        if (scope === "hold") {
          const id = options.dryRun ? "held-dryrun" : holdFinding({ stateDir, item, host, session: entry.session, vaultPath, cwd, textHash, now });
          if (id) { held.push(id); if (!options.dryRun) (done[entry.session] ??= []).push(sourceHash); }
          skipped.push("held_no_project");
          continue;
        }
        const inbox = resolveInbox(vaultPath, scope, projectId);
        if (inbox.error) { skipped.push(inbox.error); continue; }
        if (inboxHasHash(inbox.dir, textHash)) { skipped.push("duplicate"); continue; }
        let related = [];
        if (cache && index && embedQuery) {
          try {
            const [vec] = (await embedQuery([text])) ?? [];
            if (vec) {
              const match = matchVaultSemantic(index, cache, vec, { projectId: scope === "project" ? projectId : "global" });
              const top = match.hits[0];
              if (item.kind !== "explicit" && top && top.score >= NEAR_DUPLICATE_COSINE && top.path.includes("/inbox/") &&
                  /^origin:\s*"?auto-digest"?\s*$/mu.test(readText(path.join(inbox.root, top.path), 4096))) {
                skipped.push("near_duplicate");
                continue;
              }
              related = match.hits.map((h) => h.path);
            }
          } catch {}
        }
        const out = writeCandidate({ item, inbox, scope, projectId, host, session: entry.session, textHash, related, now, dryRun: options.dryRun });
        if (out.skip) { skipped.push(out.skip); continue; }
        if (!options.dryRun) (done[entry.session] ??= []).push(sourceHash);
        written.push({ path: out.path, kind: item.kind, template: out.template });
      }
    } catch (err) {
      skipped.push(`error:${String(err?.message ?? err).slice(0, 80)}`);
    }
    // A Vault that cannot be read right now (unmounted, syncing) or an unexpected error keeps the claimed
    // records for the next run; everything else (written, held, nothing worth keeping, rules say no)
    // consumes them. The live file is never touched here: it holds turns that arrived after the claim.
    const retry = skipped.some((r) => RETRYABLE.has(r) || r.startsWith("error:"));
    if (retry && stale) skipped.push("stale_queue_dropped");
    if (!options.dryRun && (!retry || stale)) {
      for (const file of files) { try { fs.unlinkSync(file); } catch {} }
    }
    appendLog(logPath, {
      ts: new Date(now).toISOString(), session: entry.session, host, vaultPath, projectId, dryRun: Boolean(options.dryRun),
      turns: findings?.turns ?? records.length, signalTurns: findings?.signalTurns ?? null,
      topics: findings?.topics.length ?? null, statements: findings?.statements.length ?? null, explicit: findings?.explicit.length ?? null,
      written: written.map((w) => w.path), ...(held.length ? { heldIds: held } : {}), skipped, ...(retry && !stale ? { kept: true } : {})
    });
    for (const w of written) summary.written.push({ session: entry.session, ...w });
    for (const id of held) summary.held.push({ session: entry.session, id });
    for (const reason of skipped) summary.skipped.push({ session: entry.session, reason });
  }
  // Keep the "already written" memory small: 30 days of sessions at most 500 entries.
  if (!options.dryRun) {
    const keys = Object.keys(done);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete done[k];
    writeJsonAtomic(doneFile, done);
  }
  return summary;
}

function readLogTail(logPath, bytes = 262144) {
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } finally { fs.closeSync(fd); }
  } catch {
    return [];
  }
}

/**
 * What the digest staged or held since the user was last told (from the digest log), marking it as
 * announced. Returns { count, paths, held, heldTotal } or null. Used once per batch in the next turn.
 */
export function takeStagedSinceNotice({ logPath = digestLogFile(), stateDir = digestStateDir(), now = Date.now() } = {}) {
  try {
    const marker = path.join(stateDir, "digest-notified.json");
    const since = Date.parse(readJson(marker)?.at ?? "") || now - 7 * 24 * 60 * 60 * 1000;
    const paths = [];
    let heldNew = 0;
    let latest = since;
    for (const r of readLogTail(logPath, 65536)) {
      const ts = Date.parse(r?.ts ?? "");
      if (!(ts > since) || r.dryRun || r.action) continue;
      if (Array.isArray(r.written)) paths.push(...r.written.filter((p) => typeof p === "string"));
      if (Array.isArray(r.heldIds)) heldNew += r.heldIds.length;
      latest = Math.max(latest, ts);
    }
    if (!paths.length && !heldNew) return null;
    writeJsonAtomic(marker, { at: new Date(latest).toISOString() });
    const heldTotal = heldNew ? listHeld({ stateDir, now }).length : 0;
    return { count: paths.length, paths: paths.slice(-5), held: heldNew, heldTotal, digestScript: DIGEST_SCRIPT };
  } catch {
    return null;
  }
}

/**
 * Retention of the digest's candidates, from the digest log and the files themselves: still pending,
 * ingested (status changed at ingest), or removed (deleted by the user: rejected). By auto_kind when known.
 */
export function digestStats({ logPath = digestLogFile(), sinceMs = 0, vaultPath: fallbackVault = null } = {}) {
  const totals = { written: 0, pending: 0, ingested: 0, removed: 0, unknown: 0 };
  const byKind = {};
  for (const r of readLogTail(logPath, 4 * 1024 * 1024)) {
    if (!Array.isArray(r.written) || r.dryRun || !(Date.parse(r.ts) >= sinceMs)) continue;
    const vault = r.vaultPath ?? fallbackVault;
    for (const rel of r.written) {
      totals.written++;
      let state = "unknown";
      let kind = "unknown";
      if (vault) {
        const text = readText(path.join(vault, rel), 4096);
        if (!text) state = fs.existsSync(path.join(vault, rel)) ? "unknown" : "removed";
        else {
          state = /^status:\s*"?ingested"?\s*$/mu.test(text) ? "ingested" : "pending";
          kind = /^auto_kind:\s*"?([\w-]+)"?\s*$/mu.exec(text)?.[1] ?? "unknown";
        }
      }
      totals[state]++;
      (byKind[kind] ??= { written: 0, pending: 0, ingested: 0, removed: 0, unknown: 0 });
      byKind[kind].written++;
      byKind[kind][state]++;
    }
  }
  const decided = totals.ingested + totals.removed;
  return { ...totals, retention: decided ? Math.round((totals.ingested / decided) * 100) / 100 : null, byKind };
}

/** Idle session queues waiting for a digest. */
export function idleSessions({ queueDir = defaultQueueDir(), now = Date.now(), idleMs = DIGEST_IDLE_MS } = {}) {
  return listQueue(queueDir).filter((e) => now - e.mtimeMs >= idleMs);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; }
}

/** True while a digest waiter process is (or is about to be) running. */
export function waiterAlive(stateDir = digestStateDir(), now = Date.now()) {
  const info = readJson(path.join(stateDir, WAITER_FILE));
  if (!info) return false;
  if (info.pid && pidAlive(info.pid)) return true;
  return !info.pid && typeof info.spawnedAt === "number" && now - info.spawnedAt < WAITER_STARTUP_MS;
}

/** Claim the waiter role for this process; false when another live waiter holds it. */
export function claimWaiter(stateDir = digestStateDir(), pid = process.pid) {
  const file = path.join(stateDir, WAITER_FILE);
  const info = readJson(file);
  if (info?.pid && info.pid !== pid && pidAlive(info.pid)) return false;
  writeJsonAtomic(file, { pid, at: Date.now() });
  return true;
}

export function releaseWaiter(stateDir = digestStateDir(), pid = process.pid) {
  const file = path.join(stateDir, WAITER_FILE);
  if (readJson(file)?.pid === pid) { try { fs.unlinkSync(file); } catch {} }
}

/**
 * Milliseconds until the next queued session (or registered host transcript with an unchecked final turn)
 * becomes idle; 0 when one already is; null when there is nothing to wait for.
 */
export function nextDigestDelay({ queueDir = defaultQueueDir(), stateDir = null, now = Date.now(), idleMs = DIGEST_IDLE_MS } = {}) {
  const delays = listQueue(queueDir).map((e) => Math.max(0, e.mtimeMs + idleMs - now));
  const transcript = nextTranscriptDelay({ stateDir, now, idleMs });
  if (transcript !== null) delays.push(transcript);
  return delays.length ? Math.min(...delays) : null;
}

/**
 * Called from hooks. When some session queue is idle and no digest ran recently or is running, start
 * `scripts/memory-digest.mjs --auto` detached and return true. When queues exist but none is idle yet,
 * make sure one background waiter (`--auto --wait`) will digest them once they are, even if no host
 * runs another hook, and return "waiter". Cheap (a directory listing and a few stats); never throws.
 */
export function maybeScheduleDigest({ queueDir = defaultQueueDir(), stateDir = digestStateDir(), now = Date.now(), idleMs = DIGEST_IDLE_MS, minIntervalMs = DIGEST_MIN_INTERVAL_MS, spawn = null, env = process.env } = {}) {
  try {
    const delay = nextDigestDelay({ queueDir, stateDir, now, idleMs });
    if (delay === null) return false;
    const run = spawn ?? defaultSpawn;
    if (delay > 0) {
      if (waiterAlive(stateDir, now)) return false;
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(path.join(stateDir, WAITER_FILE), { spawnedAt: now });
      run(process.execPath, [DIGEST_SCRIPT, "--auto", "--wait"], env);
      return "waiter";
    }
    const marker = path.join(stateDir, "digest-last-run");
    try {
      if (now - fs.statSync(marker).mtimeMs < minIntervalMs) return false;
    } catch {}
    const lock = path.join(stateDir, "digest.lock");
    try {
      if (now - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
    } catch {}
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, String(now), { mode: 0o600 });
    run(process.execPath, [DIGEST_SCRIPT, "--auto"], env);
    return true;
  } catch {
    return false;
  }
}

function defaultSpawn(command, args, env) {
  const child = spawnProcess(command, args, { detached: true, stdio: "ignore", env, windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

/** Exclusive digest lock (stale after 10 minutes). Returns a release function, or null when held. */
export function acquireDigestLock(stateDir = digestStateDir(), now = Date.now()) {
  const lock = path.join(stateDir, "digest.lock");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx", mode: 0o600 });
  } catch {
    try {
      if (now - fs.statSync(lock).mtimeMs < LOCK_STALE_MS) return null;
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }), { flag: "wx", mode: 0o600 });
    } catch {
      return null;
    }
  }
  return () => { try { fs.unlinkSync(lock); } catch {} };
}
