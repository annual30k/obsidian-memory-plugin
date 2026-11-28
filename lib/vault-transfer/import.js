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
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, LAYA_FILES, TEXT_EXT } from "./export.js";
import {
  CANDIDATE_PATH, DERIVED_PATH, INDEX_PATH, LEDGER_REL, RAW_PATH, SAME_INGEST_DIR, citedCandidates, ledgerKey, localIngestState,
  newIndexLines, parseLedger, reconcileCandidate, reconcileRaw, textHash
} from "./reconcile.js";
import { readSynced, recordSynced, syncHash } from "./sync-base.js";
import { TEMPLATE_BACKUP_DIR, TEMPLATE_NAMES, VAULT_TEMPLATE_DIR, classifyTemplate, normalizeEol } from "../vault-templates.js";
import {
  PROJECTS_FILE, addToProjectList, appendProjectEntry, findGitRoot, gitRemotes, likelyDuplicates, parseProjectsYaml
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
export function openBundle(buffer, { passphrase = null } = {}) {
  const encrypted = isEncrypted(buffer);
  const tar = decryptBundle(buffer, passphrase);
  const { files, rejected } = readTarGz(tar);

  const byName = new Map(files.map((f) => [f.name, f.data]));
  const manifestData = byName.get("manifest.json");
  if (!manifestData) throw new Error("not an Obsidian Memory export (no manifest.json)");
  let manifest;
  try { manifest = JSON.parse(manifestData.toString("utf8")); } catch { throw new Error("manifest.json is not valid JSON"); }
  if (manifest?.format !== BUNDLE_FORMAT) throw new Error("not an Obsidian Memory export (unknown format)");
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion > BUNDLE_FORMAT_VERSION) {
    throw new Error(`bundle format ${manifest.formatVersion} is newer than this plugin understands (${BUNDLE_FORMAT_VERSION}); update the plugin first`);
  }
  if (!Array.isArray(manifest.files)) throw new Error("manifest.json lists no files");
  const listed = new Set();
  const entries = [];
  for (const f of manifest.files) {
    const data = byName.get(f?.path);
    if (!data) throw new Error(`bundle is incomplete: ${f?.path} is missing`);
    if (sha256(data) !== f.sha256) throw new Error(`bundle is damaged: ${f.path} does not match its checksum`);
    if (!/^(?:vault|laya)\//u.test(f.path)) throw new Error(`unexpected path in manifest: ${f.path}`);
    listed.add(f.path);
    entries.push({ path: f.path, data });
  }
  for (const name of byName.keys()) {
    if (name !== "manifest.json" && !listed.has(name)) rejected.push({ name, reason: "not listed in the manifest" });
  }
  // Folders the export saw (empty ones included); bundles made before this list existed have none.
  const dirs = [];
  for (const d of Array.isArray(manifest.dirs) ? manifest.dirs : []) {
    const reason = typeof d === "string" && d.startsWith("vault/") ? unsafeEntryReason(d) : "not under vault/";
    if (reason) rejected.push({ name: String(d), reason }); else dirs.push(d.slice("vault/".length));
  }
  return { manifest, entries, dirs, rejected, encrypted };
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

/**
 * Work out everything an import would do. Nothing is written. Options:
 *   targetVault (absolute), passphrase, maps { id: dir }, layaDir, includeLaya (default true),
 *   replaceHeads (default false), now.
 */
export function planImport(buffer, { targetVault, passphrase = null, maps = {}, layaDir = layaHome(), includeLaya = true, replaceHeads = false, useIncomingTemplates = false, base = null, now = new Date() } = {}) {
  if (typeof targetVault !== "string" || !path.isAbsolute(targetVault)) throw new Error("target Vault must be an absolute path");
  const opened = openBundle(buffer, { passphrase });
  const { manifest } = opened;
  const state = targetState(targetVault);
  if (state === "other") throw new Error(`${targetVault} is not empty and is not an Obsidian Memory Vault; choose an empty folder or an existing Vault`);
  if (state === "unreadable") throw new Error(`${targetVault} cannot be read`);
  const conflictsRel = `${CONFLICTS_DIR}/${stamp(now)}`;
  const plan = {
    manifest, encrypted: opened.encrypted, rejected: opened.rejected, target: { path: targetVault, state },
    vault: { add: [], same: [], merged: [], conflicts: [], keptLocal: [], dirs: [], fastForward: [], keptNewer: [], deletedHere: [], deletedThere: [] },
    sync: { layaDir, set: {}, drop: [], ancestors: base ? "the --base bundle" : "the sync records" },
    templates: { upgraded: [], replaced: [], keptLocal: [], backupDir: null },
    ingest: { candidatesAdvanced: [], candidatesSame: [], rawSame: [], logEntriesSkipped: 0, duplicates: [], indexLines: [], alreadyFolded: [], removedFolded: [], ledgerAdded: 0 },
    removes: [],
    projects: [], projectChanges: null, laya: { dir: layaDir, add: [], merged: [], same: [], keptLocal: [], skipped: !includeLaya },
    warnings: [], writes: [], conflictsDir: null, duplicates: []
  };
  const write = (abs, data, mode) => plan.writes.push({ abs, data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), mode });
  const insideTarget = (rel) => {
    const abs = path.resolve(targetVault, ...rel.split("/"));
    const relBack = path.relative(path.resolve(targetVault), abs);
    if (!relBack || relBack.startsWith("..") || path.isAbsolute(relBack)) throw new Error(`refusing to write outside the Vault: ${rel}`);
    return abs;
  };

  // Case-insensitive file systems (macOS, Windows) cannot hold two names that differ only in case.
  const lower = new Map();
  for (const e of opened.entries) {
    const k = e.path.toLowerCase();
    if (lower.has(k) && lower.get(k) !== e.path) plan.warnings.push(`${e.path} and ${lower.get(k)} differ only in letter case; only one can exist on macOS/Windows`);
    lower.set(k, e.path);
  }

  // Folders that do not exist here yet (empty ones such as inbox/assets or checkpoints, which the Skill
  // and the session digest expect). Never inside the conflicts area, never over a file.
  for (const rel of opened.dirs) {
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
  // The fold ledger: union of both sides. A page the other machine folded into another page is removed
  // here when it is still exactly the folded text; an incoming page already folded here is skipped.
  const incomingByRel = new Map(opened.entries.filter((e) => e.path.startsWith("vault/")).map((e) => [e.path.slice(6), e.data]));
  const localLedger = readMaybe(insideTarget(LEDGER_REL))?.toString("utf8") ?? "";
  const ledgerUnion = mergeLines(localLedger, incomingByRel.get(LEDGER_REL)?.toString("utf8") ?? "");
  if (ledgerUnion.added) { plan.ingest.ledgerAdded = ledgerUnion.added; write(insideTarget(LEDGER_REL), ledgerUnion.text); }
  const ledger = parseLedger(ledgerUnion.text);
  const folded = new Set(ledger.map((e) => ledgerKey(e.folded, e.hash)));
  const removed = new Set();
  for (const e of ledger) {
    const local = readMaybe(insideTarget(e.folded));
    const intoExists = readMaybe(insideTarget(e.into)) !== null || incomingByRel.has(e.into);
    if (local !== null && intoExists && textHash(local.toString("utf8")) === e.hash && !removed.has(e.folded)) {
      removed.add(e.folded);
      plan.ingest.removedFolded.push({ rel: e.folded, into: e.into, device: e.device ?? null });
      plan.removes.push(insideTarget(e.folded));
    }
  }
  // Three-way: the version both machines last agreed on (an explicit older bundle, else the exporter's
  // record). Only one side changed a file since -> that side wins without a conflict.
  // Sources, most explicit first: --base, the exporter's record, this machine's own record.
  const ownRecord = readSynced(targetVault, { layaDir });
  const ancestorOf = (rel) => base?.[rel] ?? manifest.synced?.[`vault/${rel}`] ?? ownRecord[rel] ?? null;
  const agreed = (rel, data) => { plan.sync.set[rel] = syncHash(rel, data); };
  for (const r of plan.ingest.removedFolded) plan.sync.drop.push(r.rel);
  let incomingProjects = null;
  for (const e of opened.entries) {
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
    const local = readMaybe(abs);
    const key = localCandRel ?? rel;
    const anc = ancestorOf(rel);
    if (local === null) {
      if (anc && !candMatch && syncHash(rel, e.data) === anc) {
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
        write(insideTarget(copy), e.data);
        continue;
      }
      plan.vault.add.push(rel);
      write(abs, e.data);
      agreed(key, e.data);
      continue;
    }
    if (local.equals(e.data)) { plan.vault.same.push(rel); agreed(key, e.data); continue; }
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

  // Files both machines had (per the base bundle) that the other machine no longer sends: reported only,
  // since a partial export or an older bundle also leaves files out.
  if (base) {
    for (const [rel, h] of Object.entries(base)) {
      if (incomingByRel.has(rel) || removed.has(rel) || rel === PROJECTS_REL) continue;
      const local = readMaybe(insideTarget(rel));
      if (local !== null && syncHash(rel, local) === h) plan.vault.deletedThere.push(rel);
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
  }
  if (registry !== null) {
    const bundleIds = new Set((manifest.projects ?? []).map((p) => p.id));
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
  if (includeLaya) {
    for (const e of opened.entries) {
      if (!e.path.startsWith("laya/")) continue;
      const name = e.path.slice("laya/".length);
      if (name.includes("/") || !(LAYA_FILES.test(name) || name === "decisions.jsonl")) { plan.rejected.push({ name: e.path, reason: "not a Laya data file" }); continue; }
      if (name.endsWith(".json")) {
        try { const head = JSON.parse(e.data.toString("utf8")); if (!head || typeof head !== "object" || Array.isArray(head)) throw new Error(); }
        catch { plan.rejected.push({ name: e.path, reason: "not a valid JSON head" }); continue; }
      }
      const abs = path.join(layaDir, name);
      const local = readMaybe(abs);
      if (local === null) { plan.laya.add.push(name); write(abs, e.data, 0o600); continue; }
      if (local.equals(e.data)) { plan.laya.same.push(name); continue; }
      if (name.endsWith(".jsonl")) {
        const m = mergeLines(local.toString("utf8"), e.data.toString("utf8"));
        if (m.added) { plan.laya.merged.push({ name, added: m.added }); write(abs, m.text, 0o600); }
        else plan.laya.same.push(name);
        continue;
      }
      if (replaceHeads) { plan.laya.merged.push({ name, replaced: true }); write(abs, e.data, 0o600); }
      else plan.laya.keptLocal.push(name);
    }
  }
  return plan;
}

/** Create a plan's folders, then write its files (each through a temporary file, then rename). Returns the number of files written. */
export function applyImport(plan) {
  for (const rel of plan.vault?.dirs ?? []) fs.mkdirSync(path.resolve(plan.target.path, ...rel.split("/")), { recursive: true });
  // Pages the other machine folded into another one (see the fold ledger), still unchanged here.
  for (const abs of plan.removes ?? []) fs.rmSync(abs, { force: true });
  let n = 0;
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.abs), { recursive: true, mode: w.mode ? 0o700 : undefined });
    const tmp = `${w.abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, w.data, w.mode ? { mode: w.mode } : undefined);
    fs.renameSync(tmp, w.abs);
    n++;
  }
  // Remember which files now match the other machine, for the next three-way comparison.
  if (plan.sync) recordSynced(plan.target.path, plan.sync.set, plan.sync.drop, { layaDir: plan.sync.layaDir });
  return n;
}
