#!/usr/bin/env node
/**
 * Session digest runner: turns idle capture queues into pending-ingest Inbox candidates.
 *
 *   laya digest                          digest sessions idle for 20 minutes
 *   laya digest --now                    digest every queued session now
 *   laya digest --dry-run                report what would be written, write nothing, keep the queues
 *   laya digest --json                   machine-readable output
 *   laya digest --held                   findings held because their session had no project
 *   laya digest --file <id> --project <projectId> | --global     file a held finding
 *   laya digest --discard <id>           drop a held finding
 *   laya digest --stats [--days N]       what became of the digest's candidates (pending / ingested / removed)
 *
 * Hooks start it in the background with --auto (quiet). One run at a time (lock under ~/.laya/state).
 * With --wait (started by a hook while every queued session is still active) it stays in the background,
 * digests each session once it has been idle for 20 minutes, and exits when nothing is waiting or after
 * 24 hours, so a session is digested even when no host runs another hook. At most one waiter runs.
 *
 * Before digesting, it collects the final turn of idle conversations from hosts without an end-of-turn hook
 * (Antigravity transcripts registered by its hook). What a session concluded is extracted by a model through
 * a host CLI on this machine (Codex, else Hermes; OBSIDIAN_MEMORY_DIGEST_EXTRACTOR = auto | codex | hermes |
 * off). Without one ("off", or none installed) it picks turns by conclusion words and the local Laya score.
 * Uses the local Laya service when it runs (related notes, near-duplicate checks; the scores and topic
 * grouping of the keyword selection); works without it.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryJudgeFromEnv } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import { resolveExtractor, extractSession, EXTRACTORS } from "../lib/memory-router/llm-extract.js";
import {
  runDigest, acquireDigestLock, claimWaiter, releaseWaiter, nextDigestDelay, DIGEST_IDLE_MS,
  listHeld, fileHeld, discardHeld, digestStats
} from "../lib/memory-router/digest.js";
import { enqueueTurnEnd, sessionIdFor } from "../lib/memory-router/turn-context.js";
import { listTranscripts, markTranscriptChecked, antigravityLastExchange } from "../lib/memory-router/transcripts.js";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";

const WAITER_MAX_SLEEP_MS = 10 * 60 * 1000;
const WAITER_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MODEL_WAIT_MS = 45 * 1000;

export function parseArgs(argv) {
  const args = { auto: false, force: false, dryRun: false, json: false, wait: false, sessions: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") args.auto = true;
    else if (a === "--now" || a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--wait") args.wait = true;
    else if (a === "--held") args.held = true;
    else if (a === "--stats") args.stats = true;
    else if (a === "--global") args.global = true;
    else if (a === "--session" && argv[i + 1]) (args.sessions ??= []).push(argv[++i]);
    else if (a === "--file" && argv[i + 1]) args.file = argv[++i];
    else if (a === "--discard" && argv[i + 1]) args.discard = argv[++i];
    else if (a === "--project" && argv[i + 1]) args.project = argv[++i];
    else if (a === "--days" && argv[i + 1]) args.days = Number(argv[++i]);
  }
  return args;
}

/** Kept for callers of the old name; the settings come from lib/config.js memoryJudgeFromEnv. */
export function configFromEnv(env = process.env) {
  const config = memoryJudgeFromEnv(env);
  return config.mode === "strict" ? { ...config, mode: "auto" } : config;
}

/**
 * Queue the final exchange of registered host transcripts that have been idle for `idleMs` (Antigravity
 * has no end-of-turn hook). Returns the capture-queue session ids that received a turn, which the digest
 * then treats as idle. `enqueue` and `lastExchange` are injectable for tests.
 */
export function collectIdleTranscripts({ now = Date.now(), idleMs = DIGEST_IDLE_MS, stateDir = null, enqueue = enqueueTurnEnd, lastExchange = antigravityLastExchange, queueDir } = {}) {
  const ready = [];
  for (const entry of listTranscripts({ stateDir, now })) {
    if (entry.mtimeMs <= (entry.checkedMtimeMs ?? 0) || now - entry.mtimeMs < idleMs) continue;
    let queuedUserLine = entry.queuedUserLine ?? -1;
    if (entry.host === "antigravity") {
      const exchange = lastExchange(entry.transcriptPath, queuedUserLine);
      if (exchange) {
        enqueue({
          host: entry.host, sessionKey: entry.sessionKey, assistantText: exchange.reply, prompt: exchange.prompt,
          turn: { vaultPath: entry.vaultPath, cwd: entry.cwd, projectId: entry.projectId }, now, env: { OBSIDIAN_MEMORY_DIGEST: "off" },
          ...(queueDir ? { queueDir } : {})
        });
        queuedUserLine = exchange.userLine;
        ready.push(sessionIdFor(entry.host, entry.sessionKey));
      }
    }
    markTranscriptChecked(entry, { queuedUserLine, mtimeMs: entry.mtimeMs });
  }
  return ready;
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waiter loop: sleep until the next queued session (or registered transcript) is idle, digest, repeat;
 * stop when nothing is waiting or the lifetime is over. A queue kept after a run (Vault unreadable) is
 * retried at most every 10 minutes.
 */
export async function waitAndDigest({ digestOnce, queueDir, idleMs = DIGEST_IDLE_MS, now = Date.now, sleep = sleepFor, lifetimeMs = WAITER_LIFETIME_MS, maxSleepMs = WAITER_MAX_SLEEP_MS } = {}) {
  const deadline = now() + lifetimeMs;
  let runs = 0;
  let lastRunAt = -Infinity;
  while (now() < deadline) {
    const delay = nextDigestDelay({ ...(queueDir ? { queueDir } : {}), now: now(), idleMs });
    if (delay === null) break;
    const wait = Math.max(delay, lastRunAt + maxSleepMs - now());
    if (wait > 0) { await sleep(Math.min(wait + 1000, maxSleepMs)); continue; }
    await digestOnce();
    runs++;
    lastRunAt = now();
  }
  return runs;
}

/** The model extraction for runDigest, or null for the keyword selection (see the header). */
export function digestExtractor(env = process.env, resolve = resolveExtractor) {
  const wanted = env.OBSIDIAN_MEMORY_DIGEST_EXTRACTOR?.trim().toLowerCase() || "auto";
  const extractor = resolve({ preference: EXTRACTORS.includes(wanted) ? wanted : "auto", env });
  if (!extractor) return null;
  const label = extractor.model ? `${extractor.name}/${extractor.model}` : extractor.name;
  return async (session) => ({ ...(await extractSession(session, extractor.run)), extractor: label });
}

async function digestWithLock(args) {
  const release = acquireDigestLock();
  if (!release) return null;
  let router = null;
  try {
    const config = configFromEnv();
    const readySessions = args.dryRun ? [] : collectIdleTranscripts({ idleMs: args.force ? 0 : DIGEST_IDLE_MS });
    router = config.mode === "off" ? null : createMemoryRouter(config, { useCache: true });
    // Background work may wait for the model; a user's turn never does.
    if (router) await router.ensureModelReady({ waitMs: MODEL_WAIT_MS });
    const extract = digestExtractor();
    return await runDigest({
      force: args.force,
      dryRun: args.dryRun,
      sessions: args.sessions,
      readySessions,
      heartbeat: release.touch,
      ...(extract ? { extract } : {}),
      score: router ? (text) => router.captureScoreFor(text) : null,
      embed: router ? (texts, kind) => router.embedTexts(texts, kind) : null
    });
  } finally {
    router?.dispose();
    release();
  }
}

const KIND_LABEL = { turn: "session conclusion", statement: "user statement", explicit: "explicit request" };

function firstLine(text, max = 90) {
  const line = String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function printSummary(summary, args, out) {
  out.write(`Sessions digested: ${summary.processed}${args.dryRun ? " (dry run, nothing written)" : ""}\n`);
  for (const w of summary.written) out.write(`  + ${w.path} (${KIND_LABEL[w.kind] ?? w.kind})\n`);
  if (summary.held.length) out.write(`  held (no project, waiting for your decision): ${summary.held.map((h) => h.id).join(", ")}; see: laya digest --held\n`);
  const reasons = {};
  for (const s of summary.skipped) if (s.reason !== "held_no_project") reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  if (Object.keys(reasons).length) out.write(`  skipped: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
  if (summary.processed === 0) out.write("  Nothing idle to digest (use --now to digest open sessions too).\n");
}

async function heldCommands(args, out) {
  if (args.file) {
    if (!args.project && !args.global) {
      out.write("Say where it goes: --project <projectId> or --global.\n");
      return 1;
    }
    const res = fileHeld(args.file, { projectId: args.project ?? null, global: Boolean(args.global), vaultPath: resolveVaultPath() });
    out.write(res.path ? `Filed ${args.file} as ${res.path}\n` : `Not filed (${res.error}).\n`);
    return res.path ? 0 : 1;
  }
  if (args.discard) {
    const ok = discardHeld(args.discard);
    out.write(ok ? `Discarded ${args.discard}.\n` : `No held finding ${args.discard}.\n`);
    return ok ? 0 : 1;
  }
  const held = listHeld();
  if (args.json) { out.write(JSON.stringify(held.map((h) => ({ id: h.id, heldAt: h.heldAt, host: h.host, kind: h.item.kind, prompt: h.item.prompt, reply: h.item.reply ?? null })), null, 2) + "\n"); return 0; }
  if (!held.length) { out.write("No held findings.\n"); return 0; }
  out.write(`${held.length} finding(s) held because their session had no project (kept 30 days):\n`);
  for (const h of held) {
    out.write(`  ${h.id}  ${h.heldAt.slice(0, 16).replace("T", " ")}  ${h.host}  ${KIND_LABEL[h.item.kind] ?? h.item.kind}\n`);
    out.write(`      ${firstLine(h.item.kind === "turn" ? h.item.reply : h.item.prompt)}\n`);
  }
  out.write("File one: laya digest --file <id> --project <projectId> (or --global); drop one: laya digest --discard <id>\n");
  return 0;
}

function statsCommand(args, out) {
  const days = Number.isFinite(args.days) && args.days > 0 ? args.days : 30;
  const stats = digestStats({ sinceMs: Date.now() - days * 24 * 60 * 60 * 1000, vaultPath: resolveVaultPath() });
  if (args.json) { out.write(JSON.stringify(stats, null, 2) + "\n"); return 0; }
  out.write(`Digest candidates in the last ${days} days: ${stats.written} written; ${stats.pending} still pending, ${stats.ingested} ingested, ${stats.removed} removed${stats.unknown ? `, ${stats.unknown} unknown` : ""}.\n`);
  out.write(`Kept after review: ${stats.retention === null ? "n/a (nothing reviewed yet)" : `${Math.round(stats.retention * 100)}%`}\n`);
  for (const [kind, k] of Object.entries(stats.byKind)) {
    out.write(`  ${kind}: ${k.written} written, ${k.pending} pending, ${k.ingested} ingested, ${k.removed} removed\n`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), out = process.stdout) {
  const args = parseArgs(argv);
  if (args.held || args.file || args.discard) return heldCommands(args, out);
  if (args.stats) return statsCommand(args, out);
  if (args.wait) {
    if (!claimWaiter()) return 0;
    try {
      await waitAndDigest({ digestOnce: () => digestWithLock({ ...args, force: false }) });
    } finally {
      releaseWaiter();
    }
    return 0;
  }
  const summary = await digestWithLock(args);
  if (!summary) {
    if (!args.auto) out.write("Another digest is running; try again in a few minutes.\n");
    return 0;
  }
  if (args.json) out.write(JSON.stringify(summary, null, 2) + "\n");
  else if (!args.auto) printSummary(summary, args, out);
  return 0;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}
