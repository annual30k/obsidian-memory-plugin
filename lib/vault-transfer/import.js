/**
 * Import an export bundle into a Vault on this machine: plan first (nothing written), then apply.
 *
 * Into an empty or missing folder the bundle is unpacked as it is. Into an existing Vault it is merged
 * file by file, never overwriting local content:
 *   new file                       added
 *   identical                      skipped
 *   00-System/projects.yaml        merged by project id (roots and remotes added; ids never changed)
 *   log.md                         entries ("## [date] op | title" blocks) the local log lacks are appended
 *   anything else that differs     local kept; the incoming copy goes to
 *                                  00-System/import-conflicts/<stamp>/<same path> for the agent to merge
 *   only line endings differ      identical (Windows CRLF vs LF)
 *   00-System/templates/<bundled>  never a conflict: an unedited older local template is upgraded to the
 *                                  incoming current one; otherwise local kept (useIncomingTemplates
 *                                  replaces it, backed up to 00-System/template-backups/<stamp>/)
 *   .obsidian/*                    local kept
 * Laya data (~/.laya): label files merged line by line; a trained head is added when missing and otherwise
 * kept unless replaceHeads.
 *
 * Projects are then placed on this machine: a root that exists here is used; `maps[id]` binds a
 * directory (its Git root and remote); a project with remotes binds itself the first time a checkout of
 * that repository is opened; the rest are reported as not bound yet (`omem projects bind`).
 */

import fs from "node:fs";
import path from "node:path";
import { layaHome } from "../memory-router/paths.js";
import { decryptBundle, isEncrypted, readTarGz, sha256, unsafeEntryReason } from "./archive.js";
import { hashFileSync, readBundleFile } from "./stream.js";
import { deviceName } from "../vault-ingest.js";
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, LAYA_FILES, MACHINE_LOCAL_DIRS, TEXT_EXT } from "./export.js";
import {
  CANDIDATE_PATH, DERIVED_PATH, INDEX_PATH, LEDGER_REL, RAW_PATH, SAME_INGEST_DIR, citedCandidates, ledgerKey, localIngestState,
  newIndexLines, parseLedger, reconcileCandidate, reconcileRaw, textHash
} from "./reconcile.js";
import { readSynced, recordSynced, syncHash, syncHashFile, computeFilesDigest } from "./sync-base.js";
import { TEMPLATE_BACKUP_DIR, TEMPLATE_NAMES, VAULT_TEMPLATE_DIR, classifyTemplate, normalizeEol } from "../vault-templates.js";
import {
  PROJECTS_FILE, addToProjectList, appendProjectEntry, filterProjectsYaml, findGitRoot, gitRemotes, likelyDuplicates, localOnlyProjects, parseProjectsYaml
} from "./projects.js";

const PROJECTS_REL = PROJECTS_FILE.split(path.sep).join("/");
export const CONFLICTS_DIR = "00-System/import-conflicts";

function physical(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Open a bundle: decrypt, unpack, check the manifest and every file's checksum. */
/**
 * Check a bundle's members against its manifest. `members`: Map(name -> { size, sha256, data?, file? }).
 * Returns { manifest, entries, dirs, rejected } where each entry is { path, size, sha256, file?, data }
 * (`data` reads a staged file on demand, so large members are not held in memory).
 */
function validateMembers(members, rejected) {
  const manifestMember = members.get("manifest.json");
  if (!manifestMember) throw new Error("not an Obsidian Memory export (no manifest.json)");
  let manifest;
  try { manifest = JSON.parse(manifestMember.data.toString("utf8")); } catch { throw new Error("manifest.json is not valid JSON"); }
  if (manifest?.format !== BUNDLE_FORMAT) throw new Error("not an Obsidian Memory export (unknown format)");
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1 || manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new Error(`bundle format ${manifest.formatVersion} is newer than this plugin understands (${BUNDLE_FORMAT_VERSION}); update the plugin first`);
  }
  if (!Array.isArray(manifest.files)) throw new Error("manifest.json lists no files");
  const listed = new Set();
  const entries = [];
  for (const f of manifest.files) {
    const m = members.get(f?.path);
    if (!m) throw new Error(`bundle is incomplete: ${f?.path} is missing`);
    if (m.sha256 !== f.sha256) throw new Error(`bundle is damaged: ${f.path} does not match its checksum`);
    if (!/^(?:vault|laya)\//u.test(f.path)) throw new Error(`unexpected path in manifest: ${f.path}`);
    listed.add(f.path);
    entries.push(m.file
      ? { path: f.path, size: m.size, sha256: m.sha256, file: m.file, get data() { return this._data ?? fs.readFileSync(this.file); }, set data(v) { this._data = v; } }
      : { path: f.path, size: m.size, sha256: m.sha256, data: m.data });
  }
  for (const [name, m] of members) {
    if (name !== "manifest.json" && !listed.has(name)) {
      rejected.push({ name, reason: "not listed in the manifest" });
      if (m.file) fs.rmSync(m.file, { force: true });
    }
  }
  const isIncremental = manifest.bundleType === "incremental" || Boolean(manifest.incremental);
  const unchanged = [];
  if (isIncremental) {
    if (!manifest.incremental || typeof manifest.incremental !== "object") throw new Error("manifest.json has invalid incremental metadata");
    if (!Array.isArray(manifest.unchanged)) throw new Error("incremental bundle manifest is missing unchanged file list");
    const seenUnchanged = new Set();
    for (const u of manifest.unchanged) {
      if (typeof u?.path !== "string" || !u.path.startsWith("vault/")) throw new Error(`unexpected unchanged path in manifest: ${u?.path}`);
      const reason = unsafeEntryReason(u.path);
      if (reason) throw new Error(`unsafe unchanged path in manifest: ${u.path} (${reason})`);
      if (typeof u.syncHash !== "string" || !/^[0-9a-f]{64}$/u.test(u.syncHash)) throw new Error(`invalid syncHash in manifest unchanged entry: ${u.path}`);
      if (listed.has(u.path)) throw new Error(`manifest lists ${u.path} as both changed and unchanged`);
      if (seenUnchanged.has(u.path)) throw new Error(`duplicate unchanged path in manifest: ${u.path}`);
      seenUnchanged.add(u.path);
      unchanged.push({ path: u.path, size: Number(u.size) || 0, sha256: u.sha256 ?? u.syncHash, syncHash: u.syncHash });
    }
    if (manifest.incremental.baseDigest) {
      const expected = computeFilesDigest(unchanged.map((u) => [u.path, u.syncHash]));
      if (expected !== manifest.incremental.baseDigest) throw new Error("bundle is damaged: incremental unchanged file list does not match baseDigest");
    }
  }
  // Folders the export saw (empty ones included); bundles made before this list existed have none.
  const dirs = [];
  for (const d of Array.isArray(manifest.dirs) ? manifest.dirs : []) {
    const reason = typeof d === "string" && d.startsWith("vault/") ? unsafeEntryReason(d) : "not under vault/";
    if (reason) rejected.push({ name: String(d), reason }); else dirs.push(d.slice("vault/".length));
  }
  return { manifest, entries, unchanged, dirs, rejected };
}

/** Open a bundle held in memory (tests, small bundles). */
export function openBundle(buffer, { passphrase = null } = {}) {
  const encrypted = isEncrypted(buffer);
  const { files, rejected } = readTarGz(decryptBundle(buffer, passphrase));
  const members = new Map(files.map((f) => [f.name, { size: f.data.length, sha256: sha256(f.data), data: f.data }]));
  return { ...validateMembers(members, rejected), encrypted };
}

/**
 * Open a bundle file of any size by streaming it: members go to `stagingDir` (removed by the caller when
 * done) and are hashed on the way. Without a staging dir, text members stay in memory and binaries are
 * only hashed (enough for --base, which needs hashes, not files).
 */
export async function openBundleFile(file, { passphrase = null, stagingDir = null } = {}) {
  const { members, rejected, encrypted } = await readBundleFile(file, { passphrase, stagingDir });
  return { ...validateMembers(members, rejected), encrypted };
}

export function targetState(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (error) { return error.code === "ENOENT" ? "missing" : "unreadable"; }
  const visible = names.filter((n) => n !== ".DS_Store" && n !== "Thumbs.db" && n !== "desktop.ini");
  if (visible.length === 0) return "empty";
  if (fs.existsSync(path.join(dir, PROJECTS_FILE)) || fs.existsSync(path.join(dir, "10-Global"))) return "vault";
  if (visible.every((n) => n === ".obsidian")) return "empty";
  return "other";
}

// ---------------------------------------------------------------- merges

/** Split a log into its preamble and "## " entry blocks. */
function logBlocks(text) {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const blocks = [];
  let preamble = [];
  let current = null;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) fence = !fence;
    if (!fence && /^## /u.test(line)) {
      if (current) blocks.push(current);
      current = [line];
      continue;
    }
    (current ?? preamble).push(line);
  }
  if (current) blocks.push(current);
  const norm = (b) => b.join("\n").trim();
  return { preamble, blocks: blocks.map((b) => ({ text: norm(b) })) };
}

/** Append the incoming log's entries the local log does not have. Returns { text, added }. */
export function mergeLog(localText, incomingText) {
  const local = logBlocks(localText);
  const known = new Set(local.blocks.map((b) => b.text));
  // One completed ingest per candidate: an entry for a candidate the local log already records (its
  // `ingest_id: ingest-<cand>` marker) is the other machine's account of the same ingest.
  const markers = new Set([...localText.matchAll(/ingest_id:\s*(ingest-[\w-]+)/gu)].map((m) => m[1]));
  let skipped = 0;
  const fresh = logBlocks(incomingText).blocks.filter((b) => {
    if (known.has(b.text)) return false;
    const ids = [...b.text.matchAll(/ingest_id:\s*(ingest-[\w-]+)/gu)].map((m) => m[1]);
    if (ids.length && ids.every((id) => markers.has(id))) { skipped++; return false; }
    return true;
  });
  if (fresh.length === 0) return { text: localText, added: 0, skipped };
  const eol = /\r\n/u.test(localText) ? "\r\n" : "\n";
  const body = localText.replace(/\s*$/u, "");
  return { text: body + eol + eol + fresh.map((b) => b.text.split("\n").join(eol)).join(eol + eol) + eol, added: fresh.length, skipped };
}

/** Union of JSONL lines, local order first. */
export function mergeLines(localText, incomingText) {
  const have = new Set(localText.split(/\r?\n/u).filter((l) => l.trim()));
  const fresh = incomingText.split(/\r?\n/u).filter((l) => l.trim() && !have.has(l));
  if (!fresh.length) return { text: localText, added: 0 };
  const base = localText && !localText.endsWith("\n") ? localText + "\n" : localText;
  return { text: base + fresh.join("\n") + "\n", added: fresh.length };
}

/**
 * Merge an incoming projects.yaml into the local one: unknown ids are appended whole; known ids get the
 * incoming roots and remotes they lack. A remote already recorded for a different local project is
 * not copied (it would identify two projects). Returns { text, added: [ids], extended: [{ id, roots, remotes }], skipped }.
 */
export function mergeProjects(localText, incomingText) {
  let text = localText ?? "";
  const local = parseProjectsYaml(text);
  const owner = new Map();
  for (const p of local) for (const r of p.remotes) owner.set(r.toLowerCase(), p.id);
  const added = [];
  const extended = [];
  const skipped = [];
  for (const p of parseProjectsYaml(incomingText)) {
    const remotes = p.remotes.filter((r) => {
      const o = owner.get(r.toLowerCase());
      if (o && o !== p.id) { skipped.push({ id: p.id, remote: r, reason: `already recorded for ${o}` }); return false; }
      return true;
    });
    const mine = parseProjectsYaml(text).find((x) => x.id === p.id);
    if (!mine) {
      text = appendProjectEntry(text, { id: p.id, roots: p.roots, remotes, scope: p.scope });
      for (const r of remotes) owner.set(r.toLowerCase(), p.id);
      added.push(p.id);
      continue;
    }
    if (mine.scope !== p.scope) skipped.push({ id: p.id, reason: `scope differs (local ${mine.scope}, incoming ${p.scope}); local kept` });
    const before = text;
    const newRoots = p.roots.filter((r) => !mine.roots.includes(r));
    const newRemotes = remotes.filter((r) => !mine.remotes.some((m) => m.toLowerCase() === r.toLowerCase()));
    text = addToProjectList(text, p.id, "roots", newRoots);
    text = addToProjectList(text, p.id, "remotes", newRemotes);
    for (const r of newRemotes) owner.set(r.toLowerCase(), p.id);
    if (text !== before) extended.push({ id: p.id, roots: newRoots, remotes: newRemotes });
  }
  return { text, added, extended, skipped };
}

// ---------------------------------------------------------------- plan

function projectOfRel(rel) {
  if (!rel.startsWith("20-Projects/")) return null;
  const parts = rel.split("/");
  return parts[1] || null;
}

function inManifestScope(rel, manifest) {
  const scope = manifest?.scope;
  if (!scope || typeof scope !== "object") return true;
  if (scope.global === false && (rel === "10-Global" || rel.startsWith("10-Global/"))) return false;
  if (Array.isArray(scope.projects)) {
    const pid = projectOfRel(rel);
    if (pid && !scope.projects.includes(pid)) return false;
  }
  if (!scope.obsidianConfig && (rel === ".obsidian" || rel.startsWith(".obsidian/"))) return false;
  return true;
}

function filterLedgerText(text, predicate) {
  const kept = [];
  for (const line of String(text ?? "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.folded === "string" && predicate(obj.folded)) kept.push(line);
    } catch {}
  }
  return kept.length ? kept.join("\n") + "\n" : "";
}

/**
 * Work out everything an import would do. Nothing is written. Options:
 *   targetVault (absolute), passphrase, maps { id: dir }, layaDir, includeLaya (default: true, or false
 *   under onlyProjects), withGlobal (default: true, or false under onlyProjects), replaceHeads (default
 *   false), useIncomingTemplates, base, skipProjects, onlyProjects, now.
 */
export function planImport(bundle, {
  targetVault, passphrase = null, maps = {}, layaDir = layaHome(),
  includeLaya = undefined, withGlobal = undefined, replaceHeads = false, useIncomingTemplates = false,
  base = null, skipProjects = [], onlyProjects = null, now = new Date()
} = {}) {
  if (typeof targetVault !== "string" || !path.isAbsolute(targetVault)) throw new Error("target Vault must be an absolute path");
  const onlyList = Array.isArray(onlyProjects) && onlyProjects.length ? [...new Set(onlyProjects)] : null;
  const skipList = Array.isArray(skipProjects) && skipProjects.length ? [...new Set(skipProjects)] : [];
  if (onlyList && skipList.length) throw new Error("--only-project and --skip-project cannot be used together");
  const includeGlobal = withGlobal ?? !onlyList;
  const effectiveIncludeLaya = includeLaya ?? !onlyList;

  // A Buffer (in-memory bundle) or what openBundleFile returned (streamed, staged on disk).
  const opened = Buffer.isBuffer(bundle) ? openBundle(bundle, { passphrase }) : bundle;
  const { manifest } = opened;
  const rawUnchanged = opened.unchanged ?? [];
  const isIncremental = manifest.bundleType === "incremental" || Boolean(manifest.incremental);

  // Discover every project id present in the bundle (registered, packed, unchanged, or empty folder).
  const bundleProjectIds = new Set((manifest.projects ?? []).map((p) => p.id));
  for (const e of opened.entries) {
    if (e.path.startsWith("vault/")) { const pid = projectOfRel(e.path.slice(6)); if (pid) bundleProjectIds.add(pid); }
  }
  for (const u of rawUnchanged) {
    if (u.path.startsWith("vault/")) { const pid = projectOfRel(u.path.slice(6)); if (pid) bundleProjectIds.add(pid); }
  }
  for (const d of opened.dirs) {
    const pid = projectOfRel(d);
    if (pid) bundleProjectIds.add(pid);
  }
  if (onlyList) {
    const missing = onlyList.filter((id) => !bundleProjectIds.has(id));
    if (missing.length) {
      const avail = [...bundleProjectIds].sort();
      throw new Error(`project(s) not found in bundle: ${missing.join(", ")} (available: ${avail.length ? avail.join(", ") : "none"})`);
    }
  }

  // Left out before anything else looks at the bundle: projects the user chose not to bring here, and
  // the other machine's maintenance leftovers (bundles from before they were excluded at export).
  // Plus the projects this Vault keeps to itself (`transfer: local`): the other machine's copy, if it
  // has one, is not taken either.
  const targetRegistry = (() => { try { return fs.readFileSync(path.join(targetVault, PROJECTS_FILE), "utf8"); } catch { return ""; } })();
  const targetProjects = parseProjectsYaml(targetRegistry);
  const localOnly = localOnlyProjects(targetProjects);
  const localOnlySet = new Set(localOnly);
  const localOnlyRequested = onlyList ? onlyList.filter((id) => localOnlySet.has(id)) : [];
  const effectiveOnly = onlyList ? new Set(onlyList.filter((id) => !localOnlySet.has(id))) : null;
  const skip = onlyList
    ? new Set([...[...bundleProjectIds].filter((id) => !effectiveOnly.has(id)), ...localOnlyRequested])
    : new Set([...skipList, ...localOnly]);

  const inScope = (rel) => {
    if ([...MACHINE_LOCAL_DIRS].some((d) => rel === `00-System/${d}` || rel.startsWith(`00-System/${d}/`))) return false;
    if (!includeGlobal && (rel === "10-Global" || rel.startsWith("10-Global/"))) return false;
    if (onlyList) {
      if (rel === PROJECTS_REL || rel === LEDGER_REL || rel === "20-Projects") return true;
      const pid = projectOfRel(rel);
      if (pid) return effectiveOnly.has(pid);
      if (includeGlobal && (rel === "10-Global" || rel.startsWith("10-Global/"))) return true;
      return false;
    }
    const pid = projectOfRel(rel);
    if (pid && skip.has(pid)) return false;
    return true;
  };

  const skippedFiles = opened.entries.filter((e) => e.path.startsWith("vault/") && !inScope(e.path.slice(6))).length +
    rawUnchanged.filter((u) => u.path.startsWith("vault/") && !inScope(u.path.slice(6))).length;
  const entries = opened.entries
    .filter((e) => !e.path.startsWith("vault/") || inScope(e.path.slice(6)))
    .map((e) => {
      if (e.path === `vault/${PROJECTS_REL}` && (skip.size || onlyList)) {
        const text = e.data.toString("utf8");
        const keepIds = onlyList
          ? [...effectiveOnly]
          : parseProjectsYaml(text).map((p) => p.id).filter((id) => !skip.has(id));
        return { ...e, data: Buffer.from(filterProjectsYaml(text, keepIds), "utf8") };
      }
      return e;
    });
  const unchanged = rawUnchanged.filter((u) => inScope(u.path.slice(6)));
  const dirs = opened.dirs.filter((d) => inScope(d));

  const state = targetState(targetVault);
  if (state === "other") throw new Error(`${targetVault} is not empty and is not an Obsidian Memory Vault; choose an empty folder or an existing Vault`);
  if (state === "unreadable") throw new Error(`${targetVault} cannot be read`);

  if (isIncremental) {
    if (state !== "vault") {
      throw new Error(`cannot import an incremental bundle into an empty or missing folder (${targetVault}); export a full bundle (omem export --full) first`);
    }
    const expectedDevice = manifest.incremental?.baseDevice;
    if (manifest.incremental?.baseKind === "device" && expectedDevice && expectedDevice !== deviceName()) {
      throw new Error(`incremental bundle baseline mismatch: this bundle was built for device "${expectedDevice}", not this machine ("${deviceName()}"); export a full bundle (omem export --full) or an incremental bundle with --since "${deviceName()}"`);
    }
  }

  const conflictsRel = `${CONFLICTS_DIR}/${stamp(now)}`;
  const plan = {
    manifest, encrypted: opened.encrypted, rejected: opened.rejected, target: { path: targetVault, state },
    bundleType: isIncremental ? "incremental" : "full",
    incremental: isIncremental ? manifest.incremental : null,
    scope: {
      mode: onlyList ? "only-project" : "all",
      onlyProjects: onlyList ? [...effectiveOnly].sort() : null,
      includeGlobal,
      includeLaya: effectiveIncludeLaya,
      skippedProjects: [...skip].sort(),
      localOnlySkipped: onlyList ? localOnlyRequested : localOnly.filter((id) => bundleProjectIds.has(id)),
      skippedGlobal: !includeGlobal
    },
    vault: { add: [], same: [], unchanged: [], merged: [], conflicts: [], keptLocal: [], dirs: [], fastForward: [], keptNewer: [], deletedHere: [], deletedThere: [] },
    sync: { layaDir, peer: manifest.source?.device ?? "unknown", set: {}, drop: [], layaSet: {}, ancestors: base ? "the --base bundle" : "the sync records" },
    templates: { upgraded: [], replaced: [], keptLocal: [], backupDir: null },
    ingest: { candidatesAdvanced: [], candidatesSame: [], rawSame: [], logEntriesSkipped: 0, duplicates: [], indexLines: [], alreadyFolded: [], removedFolded: [], ledgerAdded: 0 },
    removes: [],
    projects: [], projectChanges: null, laya: { dir: layaDir, add: [], merged: [], same: [], keptLocal: [], skipped: !effectiveIncludeLaya },
    warnings: [], writes: [], conflictsDir: null, duplicates: [], skipped: { projects: [...skip], files: skippedFiles }
  };
  if (localOnlyRequested.length) {
    plan.warnings.push(`project(s) ${localOnlyRequested.join(", ")} are marked to stay on this machine (transfer: local) and were skipped`);
  }
  // `data` is a Buffer/string, or a bundle entry: a staged binary is copied file to file at apply time
  // instead of being loaded; text (small, and sometimes edited after planning, like a log) is read now.
  const write = (abs, data, mode) => {
    if (data && !Buffer.isBuffer(data) && typeof data === "object") {
      if (data.file && !TEXT_EXT.test(data.path)) { plan.writes.push({ abs, from: data.file, size: data.size, mode }); return; }
      data = data.data;
    }
    plan.writes.push({ abs, data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), mode });
  };
  const insideTarget = (rel) => {
    const abs = path.resolve(targetVault, ...rel.split("/"));
    const relBack = path.relative(path.resolve(targetVault), abs);
    if (!relBack || relBack.startsWith("..") || path.isAbsolute(relBack)) throw new Error(`refusing to write outside the Vault: ${rel}`);
    return abs;
  };

  // Case-insensitive file systems (macOS, Windows) cannot hold two names that differ only in case.
  const lower = new Map();
  for (const e of entries) {
    const k = e.path.toLowerCase();
    if (lower.has(k) && lower.get(k) !== e.path) plan.warnings.push(`${e.path} and ${lower.get(k)} differ only in letter case; only one can exist on macOS/Windows`);
    lower.set(k, e.path);
  }

  // Folders that do not exist here yet (empty ones such as inbox/assets or checkpoints, which the Skill
  // and the session digest expect). Never inside the conflicts area, never over a file.
  for (const rel of dirs) {
    if (rel === CONFLICTS_DIR || rel.startsWith(`${CONFLICTS_DIR}/`)) continue;
    const abs = insideTarget(rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch {}
    if (!st) plan.vault.dirs.push(rel);
    else if (!st.isDirectory()) plan.warnings.push(`${rel} is a folder in the bundle but not here; left as it is`);
  }

  // What this Vault already ingested, read before anything is written: the same candidate ingested on
  // both machines is reconciled by its id instead of reported as unrelated file conflicts.
  const localState = state === "vault" ? localIngestState(targetVault) : { candidates: {}, ingested: new Set(), citedBy: {} };
  const deferredIndexes = [];
  // The fold ledger: union of both sides (filtered to this import's scope so out-of-scope projects are
  // never touched). A page the other machine folded into another page is removed here when still identical.
  const incomingByRel = new Map(entries.filter((e) => e.path.startsWith("vault/")).map((e) => [e.path.slice(6), e]));
  const unchangedByRel = new Map(unchanged.map((u) => [u.path.slice(6), u]));
  const localLedger = readMaybe(insideTarget(LEDGER_REL))?.toString("utf8") ?? "";
  const rawIncomingLedger = incomingByRel.get(LEDGER_REL)?.data.toString("utf8") ?? "";
  const filteredIncomingLedger = (onlyList || skip.size || !includeGlobal)
    ? filterLedgerText(rawIncomingLedger, (rel) => inScope(rel))
    : rawIncomingLedger;
  const ledgerUnion = mergeLines(localLedger, filteredIncomingLedger);
  if (ledgerUnion.added) { plan.ingest.ledgerAdded = ledgerUnion.added; write(insideTarget(LEDGER_REL), ledgerUnion.text); }
  const ledger = parseLedger(ledgerUnion.text);
  const folded = new Set(ledger.map((e) => ledgerKey(e.folded, e.hash)));
  const removed = new Set();
  for (const e of ledger) {
    if (!inScope(e.folded)) continue;
    const local = readMaybe(insideTarget(e.folded));
    const intoExists = readMaybe(insideTarget(e.into)) !== null || incomingByRel.has(e.into) || unchangedByRel.has(e.into);
    if (local !== null && intoExists && textHash(local.toString("utf8")) === e.hash && !removed.has(e.folded)) {
      removed.add(e.folded);
      plan.ingest.removedFolded.push({ rel: e.folded, into: e.into, device: e.device ?? null });
      plan.removes.push(insideTarget(e.folded));
    }
  }
  // Three-way: the version both machines last agreed on (an explicit older bundle, else the exporter's
  // record). Only one side changed a file since -> that side wins without a conflict.
  // Sources, most explicit first: --base, the exporter's record, this machine's own record.
  // Records are per machine: the exporter's record for *this* machine, and this machine's record for
  // the exporter, so a third machine never inherits what two others agreed on. A pre-0.15 bundle has
  // one flat `synced` map (two machines only), used only when the per-machine field is absent.
  let ownRecord = readSynced(targetVault, { layaDir, peer: plan.sync.peer });
  let exporterView = manifest.syncedByDevice ? (manifest.syncedByDevice[deviceName()] ?? {}) : (manifest.synced ?? {});
  // A record only describes this Vault while it still holds what was recorded. Into an empty or new
  // folder, or when most recorded in-scope files are gone (full bundles only), every incoming file is
  // taken as new rather than "deleted here on purpose".
  if (state !== "vault") { ownRecord = {}; exporterView = {}; }
  else if (!isIncremental) {
    const recorded = Object.keys({ ...ownRecord, ...Object.fromEntries(Object.keys(exporterView).map((k) => [k.slice(6), 1])) })
      .filter((rel) => inScope(rel));
    const missing = recorded.filter((rel) => !fs.existsSync(path.join(targetVault, ...rel.split("/")))).length;
    if (recorded.length >= 20 && missing > recorded.length / 2) {
      plan.warnings.push(`the sync record for this Vault looks stale (${missing} of ${recorded.length} recorded files are gone); treated as a first import`);
      ownRecord = {};
      exporterView = {};
    }
  }
  const ancestorOf = (rel) => base?.[rel] ?? exporterView[`vault/${rel}`] ?? ownRecord[rel] ?? null;
  const localBaseOf = (rel) => base?.[rel] ?? ownRecord[rel] ?? null;
  const entryHash = (rel, e) => (TEXT_EXT.test(rel) ? syncHash(rel, e.data) : e.sha256);
  const agreed = (rel, data) => { plan.sync.set[rel] = data && !Buffer.isBuffer(data) && typeof data === "object" ? entryHash(data.path.slice(6), data) : syncHash(rel, data); };
  for (const r of plan.ingest.removedFolded) plan.sync.drop.push(r.rel);

  // Verify every omitted unchanged file in an incremental bundle against the target Vault on disk.
  // Never trust exporterView alone to excuse a missing or mismatched file on this Vault.
  if (isIncremental) {
    const targetProjectIds = new Set(targetProjects.map((p) => p.id));
    const mismatches = [];
    for (const u of unchanged) {
      const rel = u.path.slice("vault/".length);
      const abs = insideTarget(rel);
      if (rel === PROJECTS_REL) {
        if (!fs.existsSync(abs)) { mismatches.push({ rel, reason: "missing in target Vault" }); continue; }
        const localHash = syncHashFile(rel, abs);
        if (localHash === u.syncHash) {
          plan.vault.unchanged.push(rel);
          if (!onlyList && skip.size === 0) plan.sync.set[rel] = u.syncHash;
          continue;
        }
        const expectedIds = (manifest.projects ?? []).map((p) => p.id).filter((id) => inScope(`20-Projects/${id}/AGENTS.md`));
        const missingProj = expectedIds.filter((id) => !targetProjectIds.has(id));
        if (missingProj.length) {
          mismatches.push({ rel, reason: `missing baseline project(s): ${missingProj.join(", ")}` });
        } else {
          plan.vault.unchanged.push(rel);
        }
        continue;
      }
      if (rel === LEDGER_REL && (onlyList || skip.size || !includeGlobal)) {
        // Cross-project fold ledger may not exist or may differ when importing only a subset.
        continue;
      }
      if (!fs.existsSync(abs)) {
        if (DERIVED_PATH.test(rel) && folded.has(ledgerKey(rel, u.syncHash))) {
          plan.ingest.alreadyFolded.push(rel);
          continue;
        }
        const cm = CANDIDATE_PATH.exec(rel);
        const localCandRel = cm ? localState.candidates[cm[2]] : null;
        if (localCandRel && localBaseOf(rel) === u.syncHash) {
          plan.vault.keptNewer.push(localCandRel);
          plan.sync.set[rel] = u.syncHash;
          continue;
        }
        mismatches.push({ rel, reason: "missing in target Vault" });
        continue;
      }
      const localHash = syncHashFile(rel, abs);
      if (localHash === u.syncHash) {
        plan.vault.unchanged.push(rel);
        plan.sync.set[rel] = u.syncHash;
        continue;
      }
      if (localBaseOf(rel) === u.syncHash) {
        plan.vault.keptNewer.push(rel);
        plan.sync.set[rel] = u.syncHash;
        continue;
      }
      mismatches.push({ rel, reason: "content differs from incremental baseline" });
    }
    if (mismatches.length) {
      const sample = mismatches.slice(0, 5).map((m) => `${m.rel} (${m.reason})`).join(", ");
      const extra = mismatches.length > 5 ? ` and ${mismatches.length - 5} more` : "";
      throw new Error(
        `incremental bundle baseline mismatch: ${mismatches.length} omitted unchanged file(s) do not match this Vault (${sample}${extra}); export a full bundle (omem export --full) instead`
      );
    }
  }

  if (incomingByRel.has(LEDGER_REL) && !onlyList && skip.size === 0 && includeGlobal) {
    if (ledgerUnion.text === rawIncomingLedger || (!localLedger && rawIncomingLedger)) {
      plan.sync.set[LEDGER_REL] = syncHash(LEDGER_REL, rawIncomingLedger);
    }
  }

  let incomingProjects = null;
  for (const e of entries) {
    if (!e.path.startsWith("vault/")) continue;
    const rel = e.path.slice("vault/".length);
    if (rel === PROJECTS_REL) { incomingProjects = e.data.toString("utf8"); continue; }
    if (rel === LEDGER_REL) continue;
    if (DERIVED_PATH.test(rel) && folded.has(ledgerKey(rel, textHash(e.data.toString("utf8"))))) { plan.ingest.alreadyFolded.push(rel); continue; }
    if (removed.has(rel)) continue;
    if (rel.startsWith(`${CONFLICTS_DIR}/`)) continue;
    const candMatch = CANDIDATE_PATH.exec(rel);
    // The same candidate moved to inbox/archive/ on one machine only: reconcile it at the local path.
    const localCandRel = candMatch ? localState.candidates[candMatch[2]] : null;
    const abs = insideTarget(localCandRel ?? rel);
    const key = localCandRel ?? rel;
    const anc = ancestorOf(rel);
    if (!TEXT_EXT.test(rel)) {
      // Attachments and other binaries: compared by hash, copied file to file, never merged.
      const mine = fs.existsSync(abs) ? hashFileSync(abs) : null;
      if (mine === null) {
        if (anc && anc === e.sha256) { plan.vault.deletedHere.push(rel); continue; }
        plan.vault.add.push(rel); write(abs, e); agreed(key, e); continue;
      }
      if (mine === e.sha256) { plan.vault.same.push(rel); agreed(key, e); continue; }
      if (rel.startsWith(".obsidian/")) { plan.vault.keptLocal.push(rel); continue; }
      if (anc && mine === anc) { plan.vault.fastForward.push(key); write(abs, e); agreed(key, e); continue; }
      if (anc && e.sha256 === anc) { plan.vault.keptNewer.push(key); plan.sync.set[key] = anc; continue; }
      const copyRel = `${conflictsRel}/${rel}`;
      plan.vault.conflicts.push({ rel, copy: copyRel });
      write(insideTarget(copyRel), e);
      continue;
    }
    const local = readMaybe(abs);
    if (local === null) {
      if (anc && !candMatch && entryHash(rel, e) === anc) {
        // Both machines had this version and it was deleted here since: keep it deleted.
        plan.vault.deletedHere.push(rel);
        continue;
      }
      const derived = DERIVED_PATH.test(rel) ? citedCandidates(e.data.toString("utf8")) : [];
      const localPages = [...new Set(derived.flatMap((id) => localState.citedBy[id] ?? []))].filter((p) => !removed.has(p));
      if (derived.length && derived.every((id) => localState.ingested.has(id)) && localPages.length) {
        // Written from candidates this Vault already ingested: the other machine's synthesis of the same
        // evidence. Not a new page; parked beside the local pages that cite the same Raw.
        const copy = `${conflictsRel}/${SAME_INGEST_DIR}/${rel}`;
        plan.ingest.duplicates.push({ rel, copy, candidates: derived, localPages });
        write(insideTarget(copy), e);
        continue;
      }
      plan.vault.add.push(rel);
      write(abs, e);
      agreed(key, e);
      continue;
    }
    const incoming = e.data;
    if (local.equals(incoming)) { plan.vault.same.push(rel); agreed(key, incoming); continue; }
    // Text that differs only in line endings (CRLF from Windows, LF elsewhere) is the same note.
    if (TEXT_EXT.test(rel) && normalizeEol(local.toString("utf8")) === normalizeEol(e.data.toString("utf8"))) { plan.vault.same.push(rel); agreed(key, e.data); continue; }
    if (anc) {
      if (syncHash(rel, local) === anc) { plan.vault.fastForward.push(key); write(abs, e.data); agreed(key, e.data); continue; }
      // Only this side changed it: the agreed version is still the ancestor, recorded so the next export
      // tells the other machine to take ours.
      if (syncHash(rel, e.data) === anc) { plan.vault.keptNewer.push(key); plan.sync.set[key] = anc; continue; }
    }
    if (rel.startsWith(".obsidian/")) { plan.vault.keptLocal.push(rel); continue; }
    const templateName = rel.startsWith(`${VAULT_TEMPLATE_DIR}/`) ? rel.slice(VAULT_TEMPLATE_DIR.length + 1) : null;
    if (templateName && TEMPLATE_NAMES.includes(templateName)) {
      // Templates are schema, not memory: never parked as conflicts. An unedited older local template
      // gives way to this plugin's current one; an edited or hand-written one stays unless asked.
      const mine = classifyTemplate(templateName, local.toString("utf8"));
      const theirs = classifyTemplate(templateName, e.data.toString("utf8"));
      if (mine.state === "outdated" && theirs.state === "current") {
        plan.templates.upgraded.push(templateName);
        write(abs, e.data);
        agreed(key, e.data);
      } else if (useIncomingTemplates && mine.state !== "current") {
        plan.templates.backupDir ??= `${TEMPLATE_BACKUP_DIR}/${stamp(now)}`;
        plan.templates.replaced.push({ name: templateName, local: mine.state, incoming: theirs.state });
        write(insideTarget(`${plan.templates.backupDir}/${templateName}`), local);
        write(abs, e.data);
        agreed(key, e.data);
      } else {
        plan.templates.keptLocal.push({ name: templateName, local: mine.state, incoming: theirs.state, missingFields: mine.missingFields, problems: mine.problems });
      }
      continue;
    }
    if (candMatch) {
      const how = reconcileCandidate(local.toString("utf8"), e.data.toString("utf8"));
      if (how === "same") { plan.ingest.candidatesSame.push(rel); continue; }
      if (how === "incoming") { plan.ingest.candidatesAdvanced.push(localCandRel ?? rel); write(abs, e.data); agreed(key, e.data); continue; }
    }
    if (RAW_PATH.test(rel) && reconcileRaw(local.toString("utf8"), e.data.toString("utf8")) === "same") { plan.ingest.rawSame.push(rel); continue; }
    if (INDEX_PATH.test(rel)) { deferredIndexes.push({ rel, abs, local: local.toString("utf8"), incoming: e.data.toString("utf8") }); continue; }
    if (path.posix.basename(rel) === "log.md") {
      const m = mergeLog(local.toString("utf8"), e.data.toString("utf8"));
      plan.ingest.logEntriesSkipped += m.skipped ?? 0;
      if (m.added) { plan.vault.merged.push({ rel, added: m.added }); write(abs, m.text); }
      else plan.vault.same.push(rel);
      continue;
    }
    const copyRel = `${conflictsRel}/${rel}`;
    plan.vault.conflicts.push({ rel, copy: copyRel });
    write(insideTarget(copyRel), e.data);
  }

  // Files both machines had (per --base, or per ownRecord for incremental bundles) that the other
  // machine no longer has (neither packed nor listed in unchanged): reported only, never auto-deleted.
  const deletedCheckBase = base ?? (isIncremental ? ownRecord : null);
  if (deletedCheckBase) {
    for (const [rel, h] of Object.entries(deletedCheckBase)) {
      if (!inScope(rel) || !inManifestScope(rel, manifest)) continue;
      if (incomingByRel.has(rel) || unchangedByRel.has(rel) || removed.has(rel) || rel === PROJECTS_REL || rel === LEDGER_REL) continue;
      const abs = insideTarget(rel);
      if (fs.existsSync(abs) && syncHashFile(rel, abs) === h) plan.vault.deletedThere.push(rel);
    }
  }

  // Index notes are navigation: keep the local one and add the lines for pages this import added.
  const removedTargets = [...removed].map((r) => r.replace(/\.md$/u, ""));
  const linksRemoved = (line) => removedTargets.some((t) => line.includes(`[[${t}]]`) || line.includes(`[[${t}|`));
  const deferredRels = new Set(deferredIndexes.map((ix) => ix.rel));
  if (removed.size) {
    // Local index notes untouched by the bundle still link the removed pages.
    for (const rel of new Set([...removed].map((r) => `${r.split("/").slice(0, 2).join("/")}/index.md`))) {
      const text = readMaybe(insideTarget(rel))?.toString("utf8");
      if (text !== undefined && !deferredRels.has(rel)) deferredIndexes.push({ rel, abs: insideTarget(rel), local: text, incoming: text });
    }
  }
  for (const ix of deferredIndexes) {
    const lines = newIndexLines(ix.local, ix.incoming, plan.vault.add);
    const eol = /\r\n/u.test(ix.local) ? "\r\n" : "\n";
    const kept = ix.local.split(/\r?\n/u).filter((l) => !linksRemoved(l));
    const dropped = ix.local.split(/\r?\n/u).length - kept.length;
    if (!lines.length && !dropped) { if (ix.local !== ix.incoming) plan.vault.same.push(ix.rel); continue; }
    plan.ingest.indexLines.push({ rel: ix.rel, added: lines.length, removed: dropped });
    const base = kept.join(eol).replace(/\s*$/u, "");
    write(ix.abs, lines.length ? `${base}${eol}${eol}## Added by import ${localDay(now)}${eol}${eol}${lines.join(eol)}${eol}` : `${base}${eol}`);
  }

  // The append-only log explains pages removed because the other machine folded them into another one.
  const byScope = new Map();
  for (const r of plan.ingest.removedFolded) {
    const scope = r.rel.startsWith("10-Global/") ? "10-Global" : r.rel.split("/").slice(0, 2).join("/");
    (byScope.get(scope) ?? byScope.set(scope, []).get(scope)).push(r);
  }
  for (const [scope, items] of byScope) {
    const logAbs = insideTarget(`${scope}/log.md`);
    const pending = plan.writes.find((w) => w.abs === logAbs);
    const current = pending ? pending.data.toString("utf8") : (readMaybe(logAbs)?.toString("utf8") ?? "");
    const eol = /\r\n/u.test(current) ? "\r\n" : "\n";
    const entry = [
      `## [${localDay(now)}] maintenance | pages folded on another machine`, "",
      ...items.map((r) => `- [[${r.rel.replace(/\.md$/u, "")}]] was folded into [[${r.into.replace(/\.md$/u, "")}]]${r.device ? ` on ${r.device}` : ""}; removed here by import.`)
    ].join(eol);
    const text = `${current.replace(/\s*$/u, "")}${eol}${eol}${entry}${eol}`;
    if (pending) pending.data = Buffer.from(text, "utf8"); else write(logAbs, text);
  }

  // Projects registry: merge, then place each project on this machine.
  const projectsAbs = insideTarget(PROJECTS_REL);
  const localProjectsText = readMaybe(projectsAbs)?.toString("utf8") ?? null;
  let registry = localProjectsText;
  if (incomingProjects !== null) {
    if (localProjectsText === null) {
      registry = incomingProjects;
      plan.projectChanges = { added: parseProjectsYaml(incomingProjects).map((p) => p.id), extended: [], skipped: [] };
    } else {
      const m = mergeProjects(localProjectsText, incomingProjects);
      registry = m.text;
      plan.projectChanges = { added: m.added, extended: m.extended, skipped: m.skipped };
    }
    if (!onlyList && skip.size === 0) {
      plan.sync.set[PROJECTS_REL] = syncHash(PROJECTS_REL, incomingProjects);
    }
  }
  if (registry !== null) {
    const bundleIds = new Set(
      (manifest.projects ?? [])
        .map((p) => p.id)
        .filter((id) => (onlyList ? effectiveOnly.has(id) : !skip.has(id)))
    );
    for (const id of Object.keys(maps)) {
      if (!parseProjectsYaml(registry).some((p) => p.id === id)) plan.warnings.push(`--map ${id}: no such project in the merged registry`);
    }
    for (const p of parseProjectsYaml(registry)) {
      if (!bundleIds.has(p.id) && !maps[p.id]) continue;
      const here = p.roots.filter((r) => path.isAbsolute(r) && fs.existsSync(r));
      const entry = { id: p.id, status: null, root: null, remotes: p.remotes };
      const mapped = maps[p.id];
      if (mapped) {
        if (!fs.existsSync(mapped)) { entry.status = "map-missing"; entry.root = mapped; plan.warnings.push(`--map ${p.id}=${mapped}: directory not found`); }
        else {
          const root = physical(findGitRoot(mapped) ?? mapped);
          const remotes = gitRemotes(root).remotes;
          const taken = parseProjectsYaml(registry).find((x) => x.id !== p.id && x.roots.some((r) => path.isAbsolute(r) && physical(r) === root));
          if (taken) { entry.status = "map-conflict"; entry.root = root; plan.warnings.push(`--map ${p.id}: ${root} already belongs to ${taken.id}`); }
          else {
            registry = addToProjectList(registry, p.id, "roots", [root]);
            const owned = new Set(parseProjectsYaml(registry).filter((x) => x.id !== p.id).flatMap((x) => x.remotes.map((r) => r.toLowerCase())));
            registry = addToProjectList(registry, p.id, "remotes", remotes.filter((r) => !owned.has(r)));
            entry.status = "mapped";
            entry.root = root;
          }
        }
      } else if (here.length) {
        entry.status = "here";
        entry.root = here[0];
      } else if (p.remotes.length) {
        entry.status = "by-remote";
      } else if (p.roots.length) {
        entry.status = "unbound";
      } else {
        entry.status = "no-code-root";
      }
      plan.projects.push(entry);
    }
    if (registry !== localProjectsText) write(projectsAbs, registry);
    // The same code onboarded on each machine under its own path gets two ids; without a shared remote
    // nothing links them. Flag pairs of a project this import adds and one the Vault already had.
    const added = plan.projectChanges?.added ?? [];
    if (localProjectsText !== null && added.length) {
      const localIds = new Set(parseProjectsYaml(localProjectsText).map((p) => p.id));
      plan.duplicates = likelyDuplicates(parseProjectsYaml(registry), { among: added })
        .filter((d) => (added.includes(d.a) && localIds.has(d.b)) || (added.includes(d.b) && localIds.has(d.a)))
        .map((d) => (added.includes(d.a) ? { incoming: d.a, local: d.b, reasons: d.reasons } : { incoming: d.b, local: d.a, reasons: d.reasons }));
    }
  }

  if (plan.vault.conflicts.length || plan.ingest.duplicates.length) {
    plan.conflictsDir = conflictsRel;
    const lines = [
      "---", "title: Import conflicts", "type: import-conflicts", `created: ${now.toISOString().slice(0, 10)}`, "---", "",
      "# Import conflicts", "",
      `Imported from a bundle created ${manifest.createdAt ?? "(unknown)"} on ${manifest.source?.platform ?? "another machine"} (Vault \`${manifest.source?.vaultName ?? "?"}\`).`,
      "Each note below already existed here with different content. The local note was kept; the imported",
      "copy is beside this file under the same path. Merge each pair following the obsidian-memory Skill",
      "(update the canonical note, mark real conflicts, keep Raw unchanged), then delete this folder.", "",
      ...plan.vault.conflicts.map((c) => `- [[${c.rel.replace(/\.md$/u, "")}]] ← \`${c.copy}\``), "",
      ...(plan.ingest.duplicates.length ? [
        "## Same candidates ingested on both machines", "",
        "These pages were written on the other machine from candidates this Vault had already ingested. They",
        "were not added as new pages. For each, fold anything it says that the local pages citing the same",
        "Raw do not (classify it as support, extension, duplicate or conflict, as in an ingest), keep the local",
        "page canonical, then delete the copy.", "",
        ...plan.ingest.duplicates.map((d) => `- \`${d.copy}\` (${d.candidates.join(", ")}) → ${d.localPages.length ? d.localPages.map((p) => `[[${p.replace(/\.md$/u, "")}]]`).join(", ") : "no local page cites it; check the local log entry for where it went"}`), ""
      ] : [])
    ];
    write(insideTarget(`${conflictsRel}/README.md`), lines.join("\n"));
  }

  // Laya data.
  if (effectiveIncludeLaya) {
    for (const e of entries) {
      if (!e.path.startsWith("laya/")) continue;
      const name = e.path.slice("laya/".length);
      if (name.includes("/") || !(LAYA_FILES.test(name) || name === "decisions.jsonl")) { plan.rejected.push({ name: e.path, reason: "not a Laya data file" }); continue; }
      if (name.endsWith(".json")) {
        try { const head = JSON.parse(e.data.toString("utf8")); if (!head || typeof head !== "object" || Array.isArray(head)) throw new Error(); }
        catch { plan.rejected.push({ name: e.path, reason: "not a valid JSON head" }); continue; }
      }
      const abs = path.join(layaDir, name);
      const local = readMaybe(abs);
      if (local === null) { plan.laya.add.push(name); write(abs, e.data, 0o600); plan.sync.layaSet[name] = e.sha256; continue; }
      if (local.equals(e.data)) { plan.laya.same.push(name); plan.sync.layaSet[name] = e.sha256; continue; }
      if (name.endsWith(".jsonl")) {
        const m = mergeLines(local.toString("utf8"), e.data.toString("utf8"));
        if (m.added) { plan.laya.merged.push({ name, added: m.added }); write(abs, m.text, 0o600); }
        else plan.laya.same.push(name);
        continue;
      }
      if (replaceHeads) { plan.laya.merged.push({ name, replaced: true }); write(abs, e.data, 0o600); plan.sync.layaSet[name] = e.sha256; }
      else plan.laya.keptLocal.push(name);
    }
    if (isIncremental && Array.isArray(manifest.incremental?.layaUnchanged)) {
      for (const u of manifest.incremental.layaUnchanged) {
        if (!u || typeof u.name !== "string" || typeof u.sha256 !== "string") continue;
        if (u.name.includes("/") || !(LAYA_FILES.test(u.name) || u.name === "decisions.jsonl")) continue;
        const local = readMaybe(path.join(layaDir, u.name));
        if (local !== null && sha256(local) === u.sha256) {
          plan.laya.same.push(u.name);
          plan.sync.layaSet[u.name] = u.sha256;
        }
      }
    }
  }
  return plan;
}

let tmpSeq = 0;

function tempSibling(abs) {
  // Short name in the same folder: atomic rename, matches export.js's /\.\d+\.tmp$/ filter,
  // and never exceeds Linux ext4's 255-byte UTF-8 filename limit even when w.abs is at it.
  return path.join(path.dirname(abs), `.omem-tmp-${++tmpSeq}.${process.pid}.tmp`);
}

/** Create a plan's folders, then write its files (each through a temporary file, then rename). Returns the number of files written. */
export function applyImport(plan) {
  for (const rel of plan.vault?.dirs ?? []) fs.mkdirSync(path.resolve(plan.target.path, ...rel.split("/")), { recursive: true });
  // Pages the other machine folded into another one (see the fold ledger), still unchanged here.
  for (const abs of plan.removes ?? []) fs.rmSync(abs, { force: true });
  let n = 0;
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.abs), { recursive: true, mode: w.mode ? 0o700 : undefined });
    const tmp = tempSibling(w.abs);
    try {
      if (w.from) fs.copyFileSync(w.from, tmp);      // a staged attachment, copied without loading it
      else fs.writeFileSync(tmp, w.data, w.mode ? { mode: w.mode } : undefined);
      fs.renameSync(tmp, w.abs);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    n++;
  }
  // Remember which files now match the other machine, for the next three-way comparison.
  if (plan.sync) {
    recordSynced(plan.target.path, plan.sync.set, plan.sync.drop, {
      layaDir: plan.sync.layaDir,
      peer: plan.sync.peer,
      layaSet: plan.sync.layaSet
    });
  }
  return n;
}
