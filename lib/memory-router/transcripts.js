/**
 * Host transcripts read after the fact, for hosts without an end-of-turn hook (Antigravity).
 *
 * Antigravity only runs a hook when the next prompt starts, so the previous turn is queued then; the
 * LAST turn of a conversation (usually the one that concludes) has no next prompt. The hook therefore
 * registers each conversation here, and the background digest collects a conversation's final exchange
 * once its transcript has been idle as long as a session queue must be (collectIdleTranscripts in
 * scripts/memory-digest.mjs). Registry entries are small per-conversation JSON files under
 * ~/.laya/state/open-transcripts/, written atomically, so concurrent hook processes never contend.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir as layaStateDir } from "./paths.js";

const REGISTRY_DIR = "open-transcripts";
const REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function registryDir(stateDir) {
  return path.join(stateDir ?? layaStateDir(), REGISTRY_DIR);
}

function registryFile(stateDir, host, sessionKey) {
  const id = crypto.createHash("sha256").update(`${host}:${sessionKey}`).digest("hex").slice(0, 32);
  return path.join(registryDir(stateDir), `${id}.json`);
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

// ---------------------------------------------------------------- Antigravity transcript format

const unwrapRequest = (text) => {
  const match = String(text).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/u);
  return (match ? match[1] : String(text)).trim();
};

function transcriptLines(transcriptPath) {
  try {
    if (!transcriptPath || fs.statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) return null;
    return fs.readFileSync(transcriptPath, "utf8").trim().split("\n");
  } catch {
    return null;
  }
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The exchange that ended before line `currentLineIndex` of an Antigravity transcript: the user request
 * and the model's final text (the last PLANNER_RESPONSE with content before the current USER_INPUT).
 * Returns { prompt, reply, userLine } or null.
 */
export function antigravityExchangeBefore(transcriptPath, currentLineIndex) {
  if (!Number.isInteger(currentLineIndex)) return null;
  const lines = transcriptLines(transcriptPath);
  if (!lines) return null;
  let reply = null;
  for (let i = Math.min(currentLineIndex, lines.length) - 1; i >= 0; i--) {
    const parsed = parseLine(lines[i]);
    if (!parsed) continue;
    if (!reply && parsed.type === "PLANNER_RESPONSE" && typeof parsed.content === "string" && parsed.content.trim()) {
      reply = parsed.content;
    } else if (parsed.type === "USER_INPUT" && typeof parsed.content === "string") {
      return reply ? { prompt: unwrapRequest(parsed.content), reply, userLine: i } : null;
    }
  }
  return null;
}

/** The last completed exchange whose request is after line `afterUserLine`, or null. */
export function antigravityLastExchange(transcriptPath, afterUserLine = -1) {
  const lines = transcriptLines(transcriptPath);
  if (!lines) return null;
  const exchange = antigravityExchangeBefore(transcriptPath, lines.length);
  return exchange && exchange.userLine > afterUserLine ? exchange : null;
}

// ---------------------------------------------------------------- registry

/**
 * Record (or refresh) an open conversation: where its transcript is, where its memory goes, and the
 * transcript line of the last request whose exchange is already queued.
 */
export function registerTranscript({ host, sessionKey, transcriptPath, vaultPath = null, cwd = null, projectId = null, queuedUserLine = -1, stateDir = null, now = Date.now() } = {}) {
  if (!host || !sessionKey || !transcriptPath) return null;
  const file = registryFile(stateDir, host, sessionKey);
  const prev = readJson(file) ?? {};
  const entry = {
    host, sessionKey, transcriptPath,
    vaultPath: vaultPath ?? prev.vaultPath ?? null,
    cwd: cwd ?? prev.cwd ?? null,
    projectId: projectId ?? prev.projectId ?? null,
    queuedUserLine: Math.max(Number.isInteger(prev.queuedUserLine) ? prev.queuedUserLine : -1, queuedUserLine),
    checkedMtimeMs: prev.checkedMtimeMs ?? 0,
    touchedAt: now
  };
  writeJsonAtomic(file, entry);
  return entry;
}

/** Registered conversations (with the path of their registry file), dropping expired ones. */
export function listTranscripts({ stateDir = null, now = Date.now() } = {}) {
  const dir = registryDir(stateDir);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const entry = readJson(file);
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(entry?.transcriptPath).mtimeMs; } catch {}
    if (!entry || mtimeMs === null || now - Math.max(mtimeMs, entry.touchedAt ?? 0) > REGISTRY_TTL_MS) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    out.push({ ...entry, file, mtimeMs });
  }
  return out;
}

/** Update a registry entry after its tail was collected (or found empty). */
export function markTranscriptChecked(entry, { queuedUserLine, mtimeMs }) {
  const current = readJson(entry.file) ?? entry;
  writeJsonAtomic(entry.file, {
    ...current,
    queuedUserLine: Math.max(current.queuedUserLine ?? -1, queuedUserLine ?? -1),
    checkedMtimeMs: Math.max(current.checkedMtimeMs ?? 0, mtimeMs ?? 0)
  });
}

/**
 * Milliseconds until the earliest registered transcript becomes idle with an unchecked tail
 * (0 when one already is), or null when none is waiting. Cheap: stats only, no transcript reads.
 */
export function nextTranscriptDelay({ stateDir = null, now = Date.now(), idleMs } = {}) {
  let best = null;
  for (const entry of listTranscripts({ stateDir, now })) {
    if (entry.mtimeMs <= (entry.checkedMtimeMs ?? 0)) continue;
    const delay = Math.max(0, entry.mtimeMs + idleMs - now);
    best = best === null ? delay : Math.min(best, delay);
  }
  return best;
}
