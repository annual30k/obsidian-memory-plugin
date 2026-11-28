/**
 * What each Vault file looked like the last time this machine and another one agreed on it (the common
 * ancestor of a three-way comparison). Machine-local: ~/.laya/state/sync/<vault>.json, never in the Vault.
 *
 *   recorded  after an import, per other machine (by its device name), for every file that ends up
 *             identical to the incoming copy
 *   sent      in each export's manifest (`syncedByDevice`), so the importing machine reads what the
 *             exporter agreed on with *it*, and can tell, per file, which
 *             side changed it since: only theirs -> take theirs, only ours -> keep ours, both -> reconcile
 *   --base    an older bundle both machines started from, for Vaults that synced before this existed
 *
 * Hashes ignore line endings for text files, so a CRLF copy of a note is the same version.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { layaHome } from "../memory-router/paths.js";
import { normalizeEol } from "../vault-templates.js";
import { TEXT_EXT } from "./export.js";
import { hashFileSync, hashTextFileNormalizedSync } from "./stream.js";

export function syncHash(rel, data) {
  const h = crypto.createHash("sha256");
  if (TEXT_EXT.test(rel)) h.update(normalizeEol(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)), "utf8");
  else h.update(data);
  return h.digest("hex");
}

/** Sync hash of a file on disk, read in chunks (constant memory). */
export function syncHashFile(rel, abs) {
  return TEXT_EXT.test(rel) ? hashTextFileNormalizedSync(abs) : hashFileSync(abs);
}

/** Deterministic SHA-256 digest over a list of [path, hash] pairs. */
export function computeFilesDigest(pairs) {
  const h = crypto.createHash("sha256");
  const sorted = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [p, digest] of sorted) h.update(`${p}\0${digest}\n`, "utf8");
  return h.digest("hex");
}

export function syncStatePath(vaultPath, { layaDir = layaHome() } = {}) {
  let real = path.resolve(vaultPath);
  try { real = fs.realpathSync(vaultPath); } catch {}
  const id = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  return path.join(layaDir, "state", "sync", `${id}.json`);
}

function readState(vaultPath, options) {
  try {
    const data = JSON.parse(fs.readFileSync(syncStatePath(vaultPath, options), "utf8"));
    const peers = data && typeof data.peers === "object" && data.peers ? data.peers : {};
    // Records written before 0.15 had one flat map (two machines only); kept as a fallback.
    const legacy = data && typeof data.files === "object" && data.files ? data.files : {};
    return { peers, legacy };
  } catch {
    return { peers: {}, legacy: {} };
  }
}

/**
 * { rel: hash } this Vault last agreed on with `peer` (another machine's device name). A machine never
 * synced with has none, so a third machine cannot inherit what two others agreed on. The pre-0.15 flat
 * record answers only while no per-machine record exists yet.
 */
export function readSynced(vaultPath, options = {}) {
  const { peers, legacy } = readState(vaultPath, options);
  if (options.peer && peers[options.peer]) return peers[options.peer].files ?? {};
  return Object.keys(peers).length ? {} : legacy;
}

/** Every other machine's record: { device: { rel: hash } }. */
export function syncedPeers(vaultPath, options = {}) {
  const { peers } = readState(vaultPath, options);
  return Object.fromEntries(Object.entries(peers).map(([device, v]) => [device, v?.files ?? {}]));
}

/** Laya file hashes ({ name: sha256 }) this Vault last agreed on with `peer`. */
export function readSyncedLaya(vaultPath, options = {}) {
  const { peers } = readState(vaultPath, options);
  if (options.peer && peers[options.peer]?.laya && typeof peers[options.peer].laya === "object") {
    return peers[options.peer].laya;
  }
  return {};
}

/** Merge `set` ({ rel: hash }) into the record for `peer` and drop `drop` ([rel]). */
export function recordSynced(vaultPath, set, drop = [], options = {}) {
  const file = syncStatePath(vaultPath, options);
  const { peers, legacy } = readState(vaultPath, options);
  const peer = options.peer || "unknown";
  // The first per-machine record starts from the flat one it replaces.
  const files = { ...(peers[peer]?.files ?? (Object.keys(peers).length ? {} : legacy)), ...set };
  for (const rel of drop) delete files[rel];
  const prevLaya = peers[peer]?.laya && typeof peers[peer].laya === "object" ? peers[peer].laya : {};
  const laya = options.layaSet ? { ...prevLaya, ...options.layaSet } : prevLaya;
  const entry = { updatedAt: new Date().toISOString(), files };
  if (Object.keys(laya).length) entry.laya = laya;
  const next = { ...peers, [peer]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, vault: path.resolve(vaultPath), peers: next }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return files;
}

/** Ancestor hashes from an older bundle's entries ([{ path: "vault/<rel>", sha256, data }]) and optional unchanged list. */
export function ancestorsFromEntries(entries, unchanged = []) {
  const out = {};
  for (const u of unchanged) {
    if (!u?.path?.startsWith("vault/")) continue;
    out[u.path.slice(6)] = u.syncHash ?? u.sha256;
  }
  for (const e of entries) {
    if (!e.path.startsWith("vault/")) continue;
    const rel = e.path.slice(6);
    out[rel] = TEXT_EXT.test(rel) ? syncHash(rel, e.data) : e.sha256;
  }
  return out;
}

/** Ancestor hashes from an opened bundle (full or incremental). */
export function ancestorsFromBundle(opened) {
  return ancestorsFromEntries(opened?.entries ?? [], opened?.unchanged ?? []);
}

/** Laya file hashes ({ name: sha256 }) from an opened bundle's entries. */
export function layaHashesFromEntries(entries) {
  const out = {};
  for (const e of entries ?? []) {
    if (!e.path.startsWith("laya/")) continue;
    out[e.path.slice(5)] = e.sha256;
  }
  return out;
}
