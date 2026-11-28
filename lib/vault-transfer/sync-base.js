/**
 * What each Vault file looked like the last time this machine and another one agreed on it (the common
 * ancestor of a three-way comparison). Machine-local: ~/.laya/state/sync/<vault>.json, never in the Vault.
 *
 *   recorded  after an import, for every file that ends up identical to the incoming copy
 *   sent      in each export's manifest (`synced`), so the importing machine can tell, per file, which
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

export function syncHash(rel, data) {
  const h = crypto.createHash("sha256");
  if (TEXT_EXT.test(rel)) h.update(normalizeEol(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)), "utf8");
  else h.update(data);
  return h.digest("hex");
}

export function syncStatePath(vaultPath, { layaDir = layaHome() } = {}) {
  let real = path.resolve(vaultPath);
  try { real = fs.realpathSync(vaultPath); } catch {}
  const id = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  return path.join(layaDir, "state", "sync", `${id}.json`);
}

/** { rel: hash } recorded for this Vault (empty when none). */
export function readSynced(vaultPath, options = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(syncStatePath(vaultPath, options), "utf8"));
    return data && typeof data.files === "object" && data.files ? data.files : {};
  } catch {
    return {};
  }
}

/** Merge `set` ({ rel: hash }) into the record and drop `drop` ([rel]). */
export function recordSynced(vaultPath, set, drop = [], options = {}) {
  const file = syncStatePath(vaultPath, options);
  const files = { ...readSynced(vaultPath, options), ...set };
  for (const rel of drop) delete files[rel];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ vault: path.resolve(vaultPath), updatedAt: new Date().toISOString(), files }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  return files;
}

/** Ancestor hashes from an older bundle's entries ([{ path: "vault/<rel>", data }]). */
export function ancestorsFromEntries(entries) {
  const out = {};
  for (const e of entries) if (e.path.startsWith("vault/")) out[e.path.slice(6)] = syncHash(e.path.slice(6), e.data);
  return out;
}
