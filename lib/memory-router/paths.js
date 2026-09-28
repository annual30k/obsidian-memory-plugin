/**
 * Where the plugin keeps its files on this machine: one folder, ~/.laya, shared with the Laya service.
 *
 *   ~/.laya/                     Laya service, trained heads, labels, decisions.jsonl (per-turn log)
 *   ~/.laya/digest-log.jsonl     what each session digest wrote or skipped
 *   ~/.laya/capture-queue/       finished turns waiting for the session digest (deleted once digested)
 *   ~/.laya/state/               runtime state: session state, service health, digest bookkeeping,
 *                                Antigravity turn records
 *   ~/.laya/cache/               rebuildable caches: Vault index and note vectors (safe to delete)
 *
 * LAYA_HOME moves the parent folder, as for the `laya` command. OBSIDIAN_MEMORY_LAYA_DIR points at the
 * folder itself (tests, relocation). Files from the old location (~/.cache/obsidian-memory-plugin, or
 * %LOCALAPPDATA%\obsidian-memory-plugin) are moved here once, the first time the plugin runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path;
}

export function layaHome({ env = process.env, homedir = os.homedir, platform = process.platform } = {}) {
  const p = pathFor(platform);
  const override = typeof env.OBSIDIAN_MEMORY_LAYA_DIR === "string" ? env.OBSIDIAN_MEMORY_LAYA_DIR.trim() : "";
  if (override && p.isAbsolute(override)) return override;
  const base = typeof env.LAYA_HOME === "string" && env.LAYA_HOME.trim() ? env.LAYA_HOME.trim() : homedir();
  return p.join(base, ".laya");
}

function under(sub, name, options) {
  maybeMigrate(options);
  const p = pathFor(options?.platform ?? process.platform);
  return name ? p.join(layaHome(options), sub, name) : p.join(layaHome(options), sub);
}

export const stateFile = (name, options = {}) => under("state", name, options);
export const cacheFile = (name, options = {}) => under("cache", name, options);
export const captureQueueDir = (options = {}) => under("capture-queue", null, options);
export const stateDir = (options = {}) => under("state", null, options);
export function digestLogFile(options = {}) {
  maybeMigrate(options);
  return pathFor(options.platform ?? process.platform).join(layaHome(options), "digest-log.jsonl");
}

/** The pre-2026-09-25 location, used only to move old files. */
export function legacyCacheDir({ env = process.env, homedir = os.homedir, platform = process.platform } = {}) {
  const p = pathFor(platform);
  if (platform === "win32") {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim() ? env.LOCALAPPDATA.trim() : p.join(homedir(), "AppData", "Local");
    return p.join(base, "obsidian-memory-plugin");
  }
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() ? env.XDG_CACHE_HOME.trim() : p.join(homedir(), ".cache");
  return p.join(base, "obsidian-memory-plugin");
}

const LEGACY_MOVES = [
  ["laya-cache.json", "state/router-state.json"],
  ["session-state.json", "state/session-state.json"],
  ["digest-done.json", "state/digest-done.json"],
  ["vault-index.json", "cache/vault-index.json"],
  ["vault-embeddings.json", "cache/vault-embeddings.json"],
  ["digest-log.jsonl", "digest-log.jsonl"]
];
const LEGACY_DROP = /^(?:digest-last-run|digest\.lock)$|\.tmp$/u;

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Move the plugin's files from an old folder into a Laya folder. Never overwrites a newer file (an older
 * duplicate of plugin state is dropped), never touches a file it does not know, and removes the old
 * folder only when it ended up empty.
 * Returns { moved, dropped, removed }.
 */
export function migrateLegacyFilesAt(legacyDir, homeDir) {
  const result = { moved: [], dropped: [], removed: false };
  if (!legacyDir || !homeDir || path.resolve(legacyDir) === path.resolve(homeDir) || !fs.existsSync(legacyDir)) return result;
  for (const [from, to] of LEGACY_MOVES) {
    const src = path.join(legacyDir, from);
    const dst = path.join(homeDir, to);
    try {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) {
        // A newer copy already lives in the Laya folder: append an old log to it; an old state or cache
        // file is superseded (runtime state, rebuildable), so it is dropped rather than left behind.
        if (from.endsWith(".jsonl")) { fs.appendFileSync(dst, fs.readFileSync(src)); result.moved.push(to); }
        else result.dropped.push(from);
        fs.unlinkSync(src);
        continue;
      }
      move(src, dst);
      result.moved.push(to);
    } catch {}
  }
  const legacyQueue = path.join(legacyDir, "capture-queue");
  try {
    for (const name of fs.readdirSync(legacyQueue)) {
      const dst = path.join(homeDir, "capture-queue", name);
      if (/^[0-9a-f]{16}\.jsonl$/u.test(name) && !fs.existsSync(dst)) { move(path.join(legacyQueue, name), dst); result.moved.push(`capture-queue/${name}`); }
    }
    fs.rmdirSync(legacyQueue);
  } catch {}
  try {
    for (const name of fs.readdirSync(legacyDir)) {
      if (LEGACY_DROP.test(name)) { fs.rmSync(path.join(legacyDir, name), { force: true }); result.dropped.push(name); }
    }
    if (fs.readdirSync(legacyDir).length === 0) { fs.rmdirSync(legacyDir); result.removed = true; }
  } catch {}
  return result;
}

let migrationDone = false;

/** Once per process, when the default Laya folder is in use. Never throws. */
function maybeMigrate(options = {}) {
  if (migrationDone) return;
  migrationDone = true;
  try {
    const env = options.env ?? process.env;
    const pinned = (e) => typeof e?.OBSIDIAN_MEMORY_LAYA_DIR === "string" && e.OBSIDIAN_MEMORY_LAYA_DIR.trim();
    if (pinned(env) || pinned(process.env)) return;
    if (options.platform && options.platform !== process.platform) return;
    const home = layaHome(options);
    migrateLegacyFilesAt(legacyCacheDir(options), home);
    migrateAntigravityTurnRecords(os.tmpdir(), home);
  } catch {}
}

/** Antigravity turn records used to live in the system temp folder as antigravity-turn-<hash>.json. */
export function migrateAntigravityTurnRecords(tmpDir, homeDir) {
  let moved = 0;
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      const m = /^antigravity-turn-([0-9a-f]{32})\.json$/u.exec(name);
      if (!m) continue;
      const dst = path.join(homeDir, "state", "antigravity-turns", `${m[1]}.json`);
      try {
        if (fs.existsSync(dst)) fs.unlinkSync(path.join(tmpDir, name));
        else { move(path.join(tmpDir, name), dst); moved++; }
      } catch {}
    }
  } catch {}
  return moved;
}
