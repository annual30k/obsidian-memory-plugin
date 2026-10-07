/**
 * Capture queue: the cheap, synchronous half of automatic capture.
 *
 * Hooks append what a turn produced (the user's request and the agent's final reply, a user's lasting
 * statement, a "that fixed it" confirmation, or an explicit "remember this" that the turn did not stage)
 * to a private per-session JSONL file. Nothing is judged here and no model is called: the background
 * digest (digest.js) later merges a whole session, keeps its final conclusions and writes Inbox
 * candidates. Secrets are redacted before anything is stored; files live in ~/.laya/capture-queue/
 * (0700 / 0600).
 *
 * Layout per session: `<session>.jsonl` is the live file hooks append to. The digest claims it by an
 * atomic rename to `<session>.<ms>-<pid>.claimed.jsonl` before reading, so a turn that ends while the
 * digest runs lands in a fresh live file instead of being deleted with the claimed one. Claimed segments
 * that could not be processed yet (Vault unreadable) stay and are read together with the live file on
 * the next run.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { captureQueueDir } from "./paths.js";
import { redactSecrets, stripHostContext } from "./fast-path.js";

export const QUEUE_REPLY_MIN_CHARS = 200;
const PROMPT_MAX_CHARS = 1500;
const REPLY_MAX_CHARS = 4000;
const QUEUE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const RECORD_TYPES = new Set(["turn", "statement", "solved", "explicit"]);
const LIVE_FILE = /^([0-9a-f]{16})\.jsonl$/u;
const SEGMENT_FILE = /^([0-9a-f]{16})\.\d+-\d+\.claimed\.jsonl$/u;

// Conclusion words: the cheap feature the digest uses to pick turns that concluded something.
// Measured on 110 labelled real Codex turns together with a 200-character minimum (see ARCHITECTURE.md).
const CONCLUSION_WORDS = /根因|根本原因|根源|原因是|原因[:：]|问题在于|问题是|症状|修法|修复方法|解决方法|结论[:：]|已修复|已修好|修好|修复了|解决了|规则|约定|决定|改为|改成|不再|不能再|必须|只能|统一|以后|下一步|尚未|未完成|root cause|the cause|fixed|convention|decided|from now on|must|never|unfinished|next step/giu;

// Words that only state a finding (a cause, a fix, a decision). "只能 / 改为 / 不再 / 以后" also appear in
// ordinary explanations ("Node 里只能用 import"), so a conclusion needs at least one of these.
const STRONG_CONCLUSION_WORDS = /根因|根本原因|原因是|原因[:：]|问题在于|修法|修复方法|解决方法|已修复|已修好|修复了|解决了|结论[:：]|决定|约定|规则|root cause|the cause|fixed|decided|convention/iu;

export function hasStrongConclusion(text) {
  return typeof text === "string" && STRONG_CONCLUSION_WORDS.test(text);
}

export function conclusionKeywordCount(text) {
  return typeof text === "string" ? (text.match(CONCLUSION_WORDS) || []).length : 0;
}

export const hashKey = (value) => crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

export function sessionIdFor(host, sessionKey) {
  return sessionKey ? hashKey(`${host ?? "host"}:${sessionKey}`) : null;
}

export function defaultQueueDir(options = {}) {
  return captureQueueDir(options);
}

function clean(text, max) {
  const { text: out, redacted } = redactSecrets(typeof text === "string" ? text.trim() : "");
  return { text: out.slice(0, max), redacted };
}

/**
 * Append one record for a session. type: "turn" (needs prompt + reply), "statement" (prompt is the
 * user's lasting statement), "solved" (the user reported the previous problem fixed), "explicit" (the
 * user asked to remember the prompt and the turn staged nothing; reply is optional).
 * turn: { host, sessionKey, vaultPath, projectId, cwd }. Returns the record written, or null.
 * Never throws: capture must not break a host turn.
 */
export function enqueueCapture(type, { prompt = "", reply = "", score = null, staged = false } = {}, turn = {}, { queueDir = defaultQueueDir(), now = Date.now() } = {}) {
  try {
    if (!RECORD_TYPES.has(type)) return null;
    const session = sessionIdFor(turn.host, turn.sessionKey);
    if (!session) return null;
    // The request without host-injected context (a turn's prompt can come from a host payload directly).
    const p = clean(stripHostContext(prompt), PROMPT_MAX_CHARS);
    const r = clean(reply, REPLY_MAX_CHARS);
    if (type === "turn" && r.text.length < QUEUE_REPLY_MIN_CHARS) return null;
    if ((type === "statement" || type === "explicit") && !p.text) return null;
    const record = {
      t: type,
      ts: new Date(now).toISOString(),
      host: typeof turn.host === "string" ? turn.host.slice(0, 32) : null,
      session,
      vaultPath: typeof turn.vaultPath === "string" && path.isAbsolute(turn.vaultPath) ? turn.vaultPath : null,
      projectId: typeof turn.projectId === "string" && /^[\w.-]{1,128}$/u.test(turn.projectId) ? turn.projectId : null,
      cwd: typeof turn.cwd === "string" && path.isAbsolute(turn.cwd) ? turn.cwd : null,
      prompt: p.text,
      ...(type === "turn" ? { reply: r.text, keywords: conclusionKeywordCount(r.text) } : {}),
      ...(type === "explicit" && r.text ? { reply: r.text } : {}),
      ...(typeof score === "number" && Number.isFinite(score) ? { score: Math.round(score * 1000) / 1000 } : {}),
      ...(p.redacted || r.redacted ? { redacted: true } : {}),
      ...(staged ? { staged: true } : {})
    };
    fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });
    const file = path.join(queueDir, `${session}.jsonl`);
    try {
      if (fs.statSync(file).size > QUEUE_FILE_MAX_BYTES) return null;
      // The same request and reply is one turn, however many times a host reports it (retries, repeated hooks).
      if (readQueueFile(file).some((r) => r.t === record.t && r.prompt === record.prompt && (r.reply ?? null) === (record.reply ?? null))) return null;
    } catch {}
    fs.appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    return record;
  } catch {
    return null;
  }
}

/**
 * Queued sessions, oldest activity first: { session, file (the live path, which may not exist yet),
 * live (path|null), segments: [claimed paths], files: [all paths], mtimeMs (latest of them) }.
 */
export function listQueue(queueDir = defaultQueueDir()) {
  let names = [];
  try { names = fs.readdirSync(queueDir); } catch { return []; }
  const bySession = new Map();
  for (const name of names) {
    const live = LIVE_FILE.exec(name);
    const segment = live ? null : SEGMENT_FILE.exec(name);
    if (!live && !segment) continue;
    const session = (live ?? segment)[1];
    const file = path.join(queueDir, name);
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    const entry = bySession.get(session) ?? { session, file: path.join(queueDir, `${session}.jsonl`), live: null, segments: [], files: [], mtimeMs: 0 };
    if (live) entry.live = file; else entry.segments.push(file);
    entry.files.push(file);
    entry.mtimeMs = Math.max(entry.mtimeMs, mtimeMs);
    bySession.set(session, entry);
  }
  for (const entry of bySession.values()) entry.segments.sort();
  return [...bySession.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Take a session's live file for processing: rename it to a claimed segment (atomic; appends after this
 * go to a new live file). Returns every claimed segment of the session, oldest first, including ones
 * left by an earlier run. Only the digest (under its lock) claims.
 */
export function claimSession(entry, { now = Date.now(), pid = process.pid } = {}) {
  const segments = [...(entry.segments ?? [])];
  if (entry.live) {
    const claimed = path.join(path.dirname(entry.live), `${entry.session}.${now}-${pid}.claimed.jsonl`);
    try {
      fs.renameSync(entry.live, claimed);
      segments.push(claimed);
    } catch {}
  }
  return segments.sort();
}

/** All records of a session's files, in time order (records from one file keep their order). */
export function readSessionRecords(files) {
  const records = [];
  for (const file of files ?? []) records.push(...readQueueFile(file));
  return records.map((r, i) => ({ r, i })).sort((a, b) => a.r.ts.localeCompare(b.r.ts) || a.i - b.i).map((x) => x.r);
}

export function readQueueFile(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && RECORD_TYPES.has(r.t) && typeof r.ts === "string") out.push(r);
    } catch {}
  }
  return out;
}
