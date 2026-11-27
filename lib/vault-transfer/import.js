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
import { TEMPLATE_BACKUP_DIR, TEMPLATE_NAMES, VAULT_TEMPLATE_DIR, classifyTemplate, normalizeEol } from "../vault-templates.js";
import {
  PROJECTS_FILE, addToProjectList, appendProjectEntry, findGitRoot, gitRemotes, parseProjectsYaml
} from "./projects.js";

const PROJECTS_REL = PROJECTS_FILE.split(path.sep).join("/");
export const CONFLICTS_DIR = "00-System/import-conflicts";

function physical(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

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
  const fresh = logBlocks(incomingText).blocks.filter((b) => !known.has(b.text));
  if (fresh.length === 0) return { text: localText, added: 0 };
  const eol = /\r\n/u.test(localText) ? "\r\n" : "\n";
  const body = localText.replace(/\s*$/u, "");
  return { text: body + eol + eol + fresh.map((b) => b.text.split("\n").join(eol)).join(eol + eol) + eol, added: fresh.length };
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
export function planImport(buffer, { targetVault, passphrase = null, maps = {}, layaDir = layaHome(), includeLaya = true, replaceHeads = false, useIncomingTemplates = false, now = new Date() } = {}) {
  if (typeof targetVault !== "string" || !path.isAbsolute(targetVault)) throw new Error("target Vault must be an absolute path");
  const opened = openBundle(buffer, { passphrase });
  const { manifest } = opened;
  const state = targetState(targetVault);
  if (state === "other") throw new Error(`${targetVault} is not empty and is not an Obsidian Memory Vault; choose an empty folder or an existing Vault`);
  if (state === "unreadable") throw new Error(`${targetVault} cannot be read`);
  const conflictsRel = `${CONFLICTS_DIR}/${stamp(now)}`;
  const plan = {
    manifest, encrypted: opened.encrypted, rejected: opened.rejected, target: { path: targetVault, state },
    vault: { add: [], same: [], merged: [], conflicts: [], keptLocal: [], dirs: [] },
    templates: { upgraded: [], replaced: [], keptLocal: [], backupDir: null },
    projects: [], projectChanges: null, laya: { dir: layaDir, add: [], merged: [], same: [], keptLocal: [], skipped: !includeLaya },
    warnings: [], writes: [], conflictsDir: null
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

  let incomingProjects = null;
  for (const e of opened.entries) {
    if (!e.path.startsWith("vault/")) continue;
    const rel = e.path.slice("vault/".length);
    if (rel === PROJECTS_REL) { incomingProjects = e.data.toString("utf8"); continue; }
    if (rel.startsWith(`${CONFLICTS_DIR}/`)) continue;
    const abs = insideTarget(rel);
    const local = readMaybe(abs);
    if (local === null) { plan.vault.add.push(rel); write(abs, e.data); continue; }
    if (local.equals(e.data)) { plan.vault.same.push(rel); continue; }
    // Text that differs only in line endings (CRLF from Windows, LF elsewhere) is the same note.
    if (TEXT_EXT.test(rel) && normalizeEol(local.toString("utf8")) === normalizeEol(e.data.toString("utf8"))) { plan.vault.same.push(rel); continue; }
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
      } else if (useIncomingTemplates && mine.state !== "current") {
        plan.templates.backupDir ??= `${TEMPLATE_BACKUP_DIR}/${stamp(now)}`;
        plan.templates.replaced.push({ name: templateName, local: mine.state, incoming: theirs.state });
        write(insideTarget(`${plan.templates.backupDir}/${templateName}`), local);
        write(abs, e.data);
      } else {
        plan.templates.keptLocal.push({ name: templateName, local: mine.state, incoming: theirs.state, missingFields: mine.missingFields, problems: mine.problems });
      }
      continue;
    }
    if (path.posix.basename(rel) === "log.md") {
      const m = mergeLog(local.toString("utf8"), e.data.toString("utf8"));
      if (m.added) { plan.vault.merged.push({ rel, added: m.added }); write(abs, m.text); }
      else plan.vault.same.push(rel);
      continue;
    }
    const copyRel = `${conflictsRel}/${rel}`;
    plan.vault.conflicts.push({ rel, copy: copyRel });
    write(insideTarget(copyRel), e.data);
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
  }

  if (plan.vault.conflicts.length) {
    plan.conflictsDir = conflictsRel;
    const lines = [
      "---", "title: Import conflicts", "type: import-conflicts", `created: ${now.toISOString().slice(0, 10)}`, "---", "",
      "# Import conflicts", "",
      `Imported from a bundle created ${manifest.createdAt ?? "(unknown)"} on ${manifest.source?.platform ?? "another machine"} (Vault \`${manifest.source?.vaultName ?? "?"}\`).`,
      "Each note below already existed here with different content. The local note was kept; the imported",
      "copy is beside this file under the same path. Merge each pair following the obsidian-memory Skill",
      "(update the canonical note, mark real conflicts, keep Raw unchanged), then delete this folder.", "",
      ...plan.vault.conflicts.map((c) => `- [[${c.rel.replace(/\.md$/u, "")}]] ← \`${c.copy}\``), ""
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
  let n = 0;
  for (const w of plan.writes) {
    fs.mkdirSync(path.dirname(w.abs), { recursive: true, mode: w.mode ? 0o700 : undefined });
    const tmp = `${w.abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, w.data, w.mode ? { mode: w.mode } : undefined);
    fs.renameSync(tmp, w.abs);
    n++;
  }
  return n;
}
