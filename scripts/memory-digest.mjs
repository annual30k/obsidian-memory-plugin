#!/usr/bin/env node
/**
 * Session digest runner: turns idle capture queues into pending-ingest Inbox candidates.
 *
 *   laya digest                 digest sessions idle for 20 minutes
 *   laya digest --now           digest every queued session now
 *   laya digest --dry-run       report what would be written, write nothing, keep the queues
 *   laya digest --json          machine-readable summary
 *
 * Hooks start it in the background with --auto (quiet). One run at a time (lock under the plugin cache).
 * With --wait (started by a hook while every queued session is still active) it stays in the background,
 * digests each session once it has been idle for 20 minutes, and exits when the queue is empty or after
 * 24 hours, so a session is digested even when no host runs another hook. At most one waiter runs.
 * Uses the local Laya service when it runs (capture score for replies with few conclusion words, and
 * the retriever for topic grouping, related notes and near-duplicate checks); works without it.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMemoryJudgeConfig } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import { runDigest, acquireDigestLock, claimWaiter, releaseWaiter, nextDigestDelay, DIGEST_IDLE_MS } from "../lib/memory-router/digest.js";

const WAITER_MAX_SLEEP_MS = 10 * 60 * 1000;
const WAITER_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function parseArgs(argv) {
  const args = { auto: false, force: false, dryRun: false, json: false, wait: false, sessions: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") args.auto = true;
    else if (a === "--now" || a === "--force") args.force = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--wait") args.wait = true;
    else if (a === "--session" && argv[i + 1]) (args.sessions ??= []).push(argv[++i]);
  }
  return args;
}

export function configFromEnv(env = process.env) {
  const input = {};
  const mode = env.OBSIDIAN_MEMORY_JUDGE_MODE?.trim();
  if (["off", "auto", "strict", "manual"].includes(mode)) input.mode = mode === "strict" ? "auto" : mode;
  if (env.OBSIDIAN_MEMORY_ENDPOINT) input.endpoint = env.OBSIDIAN_MEMORY_ENDPOINT.trim();
  if (env.OBSIDIAN_MEMORY_SERVICE_FILE) input.serviceFile = env.OBSIDIAN_MEMORY_SERVICE_FILE.trim();
  return parseMemoryJudgeConfig(input);
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waiter loop: sleep until the next queued session is idle, digest, repeat; stop when the queue is empty or
 * the lifetime is over. A queue kept after a run (Vault unreadable) is retried at most every 10 minutes.
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

async function digestWithLock(args) {
  const release = acquireDigestLock();
  if (!release) return null;
  let router = null;
  try {
    const config = configFromEnv();
    router = config.mode === "off" ? null : createMemoryRouter(config, { useCache: true });
    return await runDigest({
      force: args.force,
      dryRun: args.dryRun,
      sessions: args.sessions,
      score: router ? (text) => router.captureScoreFor(text) : null,
      embed: router ? (texts, kind) => router.embedTexts(texts, kind) : null
    });
  } finally {
    router?.dispose();
    release();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.wait) {
    if (!claimWaiter()) return 0;
    try {
      await waitAndDigest({ digestOnce: () => digestWithLock({ ...args, force: false }) });
    } finally {
      releaseWaiter();
    }
    return 0;
  }
  const release = acquireDigestLock();
  if (!release) {
    if (!args.auto) process.stdout.write("Another digest is running; try again in a few minutes.\n");
    return 0;
  }
  let router = null;
  try {
    const config = configFromEnv();
    router = config.mode === "off" ? null : createMemoryRouter(config, { useCache: true });
    const summary = await runDigest({
      force: args.force,
      dryRun: args.dryRun,
      sessions: args.sessions,
      score: router ? (text) => router.captureScoreFor(text) : null,
      embed: router ? (texts, kind) => router.embedTexts(texts, kind) : null
    });
    if (args.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    else if (!args.auto) {
      process.stdout.write(`Sessions digested: ${summary.processed}${args.dryRun ? " (dry run, nothing written)" : ""}\n`);
      for (const w of summary.written) process.stdout.write(`  + ${w.path} (${w.kind === "turn" ? "session conclusion" : "user statement"})\n`);
      const reasons = {};
      for (const s of summary.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
      if (Object.keys(reasons).length) process.stdout.write(`  skipped: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);
      if (summary.processed === 0) process.stdout.write("  Nothing idle to digest (use --now to digest open sessions too).\n");
    }
    return 0;
  } finally {
    router?.dispose();
    release();
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}
