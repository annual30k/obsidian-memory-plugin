/**
 * Capture queue: the cheap, synchronous half of automatic capture.
 *
 * Hooks append what a turn produced (the user's request and the agent's final reply, or a user's
 * lasting statement, or a "that fixed it" confirmation) to a private per-session JSONL file. Nothing
 * is judged here and no model is called: the background digest (digest.js) later merges a whole
 * session, keeps its final conclusions and writes Inbox candidates. Secrets are redacted before
 * anything is stored; files live in ~/.laya/capture-queue/ (0700 / 0600).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { captureQueueDir } from "./paths.js";
import { redactSecrets } from "./fast-path.js";

export const QUEUE_REPLY_MIN_CHARS = 200;
const PROMPT_MAX_CHARS = 1500;
const REPLY_MAX_CHARS = 4000;
const QUEUE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const RECORD_TYPES = new Set(["turn", "statement", "solved"]);

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
 * user's lasting statement), "solved" (the user reported the previous problem fixed).
 * turn: { host, sessionKey, vaultPath, projectId, cwd }. Returns the record written, or null.
 * Never throws: capture must not break a host turn.
 */
export function enqueueCapture(type, { prompt = "", reply = "", score = null, staged = false } = {}, turn = {}, { queueDir = defaultQueueDir(), now = Date.now() } = {}) {
  try {
    if (!RECORD_TYPES.has(type)) return null;
    const session = sessionIdFor(turn.host, turn.sessionKey);
    if (!session) return null;
    const p = clean(prompt, PROMPT_MAX_CHARS);
    const r = clean(reply, REPLY_MAX_CHARS);
    if (type === "turn" && r.text.length < QUEUE_REPLY_MIN_CHARS) return null;
    if (type === "statement" && !p.text) return null;
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

/** Queue files with their last-modified time, oldest first. */
export function listQueue(queueDir = defaultQueueDir()) {
  let names = [];
  try { names = fs.readdirSync(queueDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^[0-9a-f]{16}\.jsonl$/u.test(name)) continue;
    const file = path.join(queueDir, name);
    try { out.push({ session: name.slice(0, 16), file, mtimeMs: fs.statSync(file).mtimeMs }); } catch {}
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
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
