/**
 * Pre-import snapshots and one-click rollback (`omem import rollback`).
 *
 * Stored strictly outside the Vault under ~/.laya/backups/imports/<vault-hash>/<snapshot-id>/
 * (mode 0700/0600) so backups never pollute notes or get re-exported. Payload backups use flat
 * numbered files (files/0, files/1, ...) so long filenames (Linux 255-byte limit, Windows MAX_PATH)
 * always back up and restore reliably with constant memory via file-to-file copies.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { layaHome } from "../memory-router/paths.js";
import { hashFileSync } from "./stream.js";
import { syncStatePath } from "./sync-base.js";

export const DEFAULT_KEEP_SNAPSHOTS = 10;

function vaultKey(vaultPath) {
  let real = path.resolve(vaultPath);
  try { real = fs.realpathSync(vaultPath); } catch {}
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

function makeSnapshotId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

export function snapshotsRoot(vaultPath, { layaDir = layaHome() } = {}) {
  return path.join(layaDir, "backups", "imports", vaultKey(vaultPath));
}

function atomicCopyFile(from, to, mode) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: mode ? 0o700 : undefined });
  const tmp = path.join(path.dirname(to), `.omem-rb-${crypto.randomBytes(4).toString("hex")}.${process.pid}.tmp`);
  try {
    fs.copyFileSync(from, tmp);
    if (mode) { try { fs.chmodSync(tmp, mode); } catch {} }
    fs.renameSync(tmp, to);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.omem-snap-${crypto.randomBytes(4).toString("hex")}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function relWithin(root, abs) {
  const r = path.relative(path.resolve(root), path.resolve(abs));
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  return r.split(path.sep).join("/");
}

/**
 * Capture every file and state that `plan` is about to create, overwrite, or delete BEFORE apply runs.
 * Returns a handle `{ id, dir, meta, finalize() }`. Call `finalize()` right after writes/removes/sync
 * finish so each entry records its post-import hash (used by rollback's anti-clobber check).
 */
export function beginImportSnapshot(plan, {
  layaDir = plan.sync?.layaDir ?? layaHome(),
  bundleName = null,
  now = new Date(),
  keepLast = DEFAULT_KEEP_SNAPSHOTS
} = {}) {
  const targetVault = path.resolve(plan.target.path);
  const targetLaya = path.resolve(plan.laya?.dir ?? layaDir);
  const root = snapshotsRoot(targetVault, { layaDir });
  const id = makeSnapshotId(now);
  const dir = path.join(root, id);
  const filesDir = path.join(dir, "files");
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });

  let seq = 0;
  const seen = new Map();
  const entries = [];
  const track = (abs, op) => {
    const resolved = path.resolve(abs);
    if (seen.has(resolved)) return seen.get(resolved);
    let kind = null;
    let rel = relWithin(targetVault, resolved);
    if (rel !== null) kind = "vault";
    else {
      rel = relWithin(targetLaya, resolved);
      if (rel !== null) kind = "laya";
    }
    if (!kind || !rel) return null;
    const existedBefore = fs.existsSync(resolved);
    let beforeHash = null;
    let backupKey = null;
    if (existedBefore) {
      beforeHash = hashFileSync(resolved);
      backupKey = `files/${seq++}`;
      fs.copyFileSync(resolved, path.join(dir, backupKey));
      try { fs.chmodSync(path.join(dir, backupKey), 0o600); } catch {}
    }
    const entry = { kind, rel, op, existedBefore, beforeHash, afterHash: null, backupKey, _abs: resolved };
    seen.set(resolved, entry);
    entries.push(entry);
    return entry;
  };

  for (const abs of plan.removes ?? []) track(abs, "remove");
  for (const w of plan.writes ?? []) track(w.abs, fs.existsSync(w.abs) ? "modify" : "add");

  const createdDirs = [];
  for (const rel of plan.vault?.dirs ?? []) {
    const abs = path.resolve(targetVault, ...rel.split("/"));
    if (!fs.existsSync(abs)) createdDirs.push(rel);
  }
  // Also record parent dirs that do not exist yet for newly written Vault files so rollback cleans empty folders.
  const dirSet = new Set(createdDirs);
  for (const e of entries) {
    if (e.kind !== "vault" || e.existedBefore) continue;
    let cur = path.posix.dirname(e.rel);
    while (cur && cur !== ".") {
      const abs = path.resolve(targetVault, ...cur.split("/"));
      if (fs.existsSync(abs)) break;
      if (!dirSet.has(cur)) { dirSet.add(cur); createdDirs.push(cur); }
      cur = path.posix.dirname(cur);
    }
  }

  const syncFile = syncStatePath(targetVault, { layaDir });
  const syncExisted = fs.existsSync(syncFile);
  let syncBackupKey = null;
  if (syncExisted) {
    syncBackupKey = "sync-state.json";
    fs.copyFileSync(syncFile, path.join(dir, syncBackupKey));
    try { fs.chmodSync(path.join(dir, syncBackupKey), 0o600); } catch {}
  }

  const meta = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    vaultPath: targetVault,
    layaDir: targetLaya,
    targetStateBefore: plan.target.state,
    bundle: {
      name: bundleName ?? null,
      type: plan.bundleType ?? "full",
      sourceDevice: plan.manifest?.source?.device ?? null,
      sourceVault: plan.manifest?.source?.vaultName ?? null,
      createdAt: plan.manifest?.createdAt ?? null
    },
    scope: plan.scope ?? null,
    summary: {
      added: entries.filter((e) => e.kind === "vault" && !e.existedBefore).length,
      modified: entries.filter((e) => e.kind === "vault" && e.existedBefore && e.op !== "remove").length,
      removed: entries.filter((e) => e.kind === "vault" && e.op === "remove").length,
      renamed: (plan.vault?.renamed ?? []).length,
      layaChanged: entries.filter((e) => e.kind === "laya").length
    },
    createdDirs,
    entries: [],
    syncState: {
      existedBefore: syncExisted,
      backupKey: syncBackupKey,
      // Rollback restores only this machine's record, so other machines' baselines survive.
      peer: plan.sync?.peer ?? plan.manifest?.source?.device ?? "unknown"
    },
    // "incomplete" until finalize(): written now so a crash or failed write can still be rolled back.
    status: "incomplete",
    rolledBackAt: null
  };
  const metaFile = path.join(dir, "snapshot.json");
  const strip = (withAfter) => entries.map(({ _abs, ...rest }) => ({
    ...rest,
    afterHash: withAfter && fs.existsSync(_abs) ? hashFileSync(_abs) : null
  }));
  meta.entries = strip(false);
  atomicWriteJson(metaFile, meta);

  return {
    id,
    dir,
    meta,
    /** Record post-import hashes. `{ error }` marks an import that stopped part-way (still rollbackable). */
    finalize({ error = null } = {}) {
      meta.entries = strip(true);
      meta.status = error ? "failed" : "complete";
      if (error) meta.error = String(error?.message ?? error);
      atomicWriteJson(metaFile, meta);
      if (Number.isInteger(keepLast) && keepLast > 0) pruneSnapshots(targetVault, { layaDir, keepLast });
      return meta;
    },
    abort() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Delete oldest snapshots beyond `keepLast`. */
export function pruneSnapshots(vaultPath, { layaDir = layaHome(), keepLast = DEFAULT_KEEP_SNAPSHOTS } = {}) {
  const all = listImportSnapshots(vaultPath, { layaDir });
  const drop = all.slice(keepLast);
  for (const s of drop) fs.rmSync(s.dir, { recursive: true, force: true });
  return drop.map((s) => s.id);
}

/** List snapshots for `vaultPath`, newest first. */
export function listImportSnapshots(vaultPath, { layaDir = layaHome() } = {}) {
  const root = snapshotsRoot(vaultPath, { layaDir });
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const metaFile = path.join(dir, "snapshot.json");
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      if (meta && typeof meta.id === "string") out.push({ ...meta, dir });
    } catch {}
  }
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id));
}

function insideRoot(root, rel) {
  const abs = path.resolve(root, ...rel.split("/"));
  const back = path.relative(path.resolve(root), abs);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) throw new Error(`refusing to touch path outside root: ${rel}`);
  return abs;
}

/**
 * Plan a rollback for `snapshotId` (or the latest un-rolled-back snapshot when omitted).
 * Checks every file's current hash against `afterHash` so manual user edits made after the import
 * are never silently overwritten unless `force: true`.
 */
export function planRollback(vaultPath, { snapshotId = null, layaDir = layaHome(), force = false } = {}) {
  if (typeof vaultPath !== "string" || !path.isAbsolute(vaultPath)) throw new Error("target Vault must be an absolute path");
  const all = listImportSnapshots(vaultPath, { layaDir });
  if (all.length === 0) throw new Error(`no import snapshots found for ${vaultPath}`);
  let snap;
  if (snapshotId) {
    snap = all.find((s) => s.id === snapshotId);
    if (!snap) {
      const avail = all.slice(0, 5).map((s) => s.id).join(", ");
      throw new Error(`import snapshot not found: ${snapshotId} (available: ${avail})`);
    }
  } else {
    snap = all.find((s) => !s.rolledBackAt) ?? all[0];
  }

  const targetVault = path.resolve(vaultPath);
  const targetLaya = path.resolve(snap.layaDir ?? layaDir);
  const plan = {
    snapshot: snap,
    targetVault,
    layaDir,
    targetLaya,
    force: Boolean(force),
    restore: [],
    remove: [],
    alreadyDone: [],
    modifiedSinceImport: [],
    removeDirs: [...(snap.createdDirs ?? [])].sort((a, b) => b.split("/").length - a.split("/").length)
  };

  for (const e of snap.entries ?? []) {
    const root = e.kind === "laya" ? targetLaya : targetVault;
    const abs = insideRoot(root, e.rel);
    const exists = fs.existsSync(abs);
    const currentHash = exists ? hashFileSync(abs) : null;

    if (!e.existedBefore) {
      // File was added by the import -> rollback deletes it.
      if (!exists) { plan.alreadyDone.push({ kind: e.kind, rel: e.rel }); continue; }
      if (e.afterHash && currentHash !== e.afterHash) {
        if (!force) {
          plan.modifiedSinceImport.push({ kind: e.kind, rel: e.rel, reason: "added by import, then edited locally" });
          continue;
        }
      }
      plan.remove.push({ kind: e.kind, rel: e.rel, abs, forced: Boolean(e.afterHash && currentHash !== e.afterHash) });
      continue;
    }

    // File existed before the import (modified or removed by import) -> rollback restores backup.
    const backupAbs = e.backupKey ? path.join(snap.dir, e.backupKey) : null;
    if (!backupAbs || !fs.existsSync(backupAbs)) {
      throw new Error(`snapshot ${snap.id} is damaged: backup payload missing for ${e.rel}`);
    }
    if (exists && currentHash === e.beforeHash) {
      plan.alreadyDone.push({ kind: e.kind, rel: e.rel });
      continue;
    }
    // An "incomplete" snapshot (process killed mid-import) has no post-import hashes to compare with.
    const matchesAfter = snap.status === "incomplete"
      ? true
      : (e.afterHash === null ? !exists : (exists && currentHash === e.afterHash));
    if (!matchesAfter) {
      if (!force) {
        plan.modifiedSinceImport.push({
          kind: e.kind,
          rel: e.rel,
          reason: e.afterHash === null ? "deleted by import, then recreated locally" : "modified again after import"
        });
        continue;
      }
    }
    plan.restore.push({ kind: e.kind, rel: e.rel, abs, from: backupAbs, forced: !matchesAfter });
  }

  return plan;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Put back the sync record of the machine this import came from, as it was before the import. Records
 * for other machines (later imports from them included) are left as they are now.
 */
function restoreSyncRecord(plan) {
  const syncFile = syncStatePath(plan.targetVault, { layaDir: plan.layaDir });
  const snap = plan.snapshot;
  const peer = snap.syncState?.peer ?? snap.bundle?.sourceDevice ?? "unknown";
  const before = snap.syncState?.existedBefore && snap.syncState.backupKey
    ? readJson(path.join(snap.dir, snap.syncState.backupKey))
    : null;
  const current = readJson(syncFile);
  if (!current) {
    if (before) atomicCopyFile(path.join(snap.dir, snap.syncState.backupKey), syncFile, 0o600);
    return;
  }
  const peers = { ...(current.peers && typeof current.peers === "object" ? current.peers : {}) };
  const beforePeers = before?.peers && typeof before.peers === "object" ? before.peers : {};
  if (beforePeers[peer]) peers[peer] = beforePeers[peer];
  else delete peers[peer];
  const next = { version: 2, vault: current.vault ?? path.resolve(plan.targetVault), peers };
  // A pre-0.15 flat record was turned into this machine's entry by the import: bring it back too.
  const legacy = before && !before.peers && before.files && typeof before.files === "object" ? before.files : null;
  if (legacy && !Object.keys(peers).length) next.files = legacy;
  if (!Object.keys(peers).length && !next.files) { fs.rmSync(syncFile, { force: true }); return; }
  atomicWriteJson(syncFile, next);
}

/** Execute a rollback plan. Refuses when files were edited after import unless `plan.force` is true. */
export function applyRollback(plan) {
  if (plan.modifiedSinceImport.length > 0 && !plan.force) {
    const sample = plan.modifiedSinceImport.slice(0, 5).map((m) => `${m.rel} (${m.reason})`).join(", ");
    const extra = plan.modifiedSinceImport.length > 5 ? ` and ${plan.modifiedSinceImport.length - 5} more` : "";
    throw new Error(
      `refusing to roll back: ${plan.modifiedSinceImport.length} file(s) were modified after the import (${sample}${extra}); pass --force to overwrite local changes`
    );
  }
  let changed = 0;
  for (const r of plan.remove) {
    fs.rmSync(r.abs, { force: true });
    changed++;
  }
  for (const r of plan.restore) {
    atomicCopyFile(r.from, r.abs, r.kind === "laya" ? 0o600 : undefined);
    changed++;
  }
  for (const rel of plan.removeDirs) {
    try {
      const abs = insideRoot(plan.targetVault, rel);
      fs.rmdirSync(abs);
    } catch {}
  }
  restoreSyncRecord(plan);
  // Mark snapshot as rolled back.
  const metaFile = path.join(plan.snapshot.dir, "snapshot.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta.rolledBackAt = new Date().toISOString();
    atomicWriteJson(metaFile, meta);
  } catch {}
  return changed;
}
