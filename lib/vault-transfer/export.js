/**
 * Build an export bundle of a Vault (and the user's own Laya data) for another machine.
 *
 * Bundle layout (inside the tar.gz):
 *   manifest.json      format, versions, scope, projects (roots + remotes), every file's size and sha256
 *   vault/...          the Vault's notes; 00-System/projects.yaml with Git remotes recorded
 *   laya/...           labels*.jsonl, recall-head.json, durable-head.json (and decisions.jsonl on request)
 *
 * Left out: dot folders (.obsidian unless asked, .git, .trash, other tools' folders), OS litter, symlinks,
 * names that could not be created on every system, and everything machine-local in ~/.laya (venv,
 * caches, state, queues, logs). The Vault is only read.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layaHome } from "../memory-router/paths.js";
import { createTarGz, encryptBundle, sha256, unsafeEntryReason } from "./archive.js";
import { PROJECTS_FILE, filterProjectsYaml, localOnlyProjects, parseProjectsYaml } from "./projects.js";
import { backfillRemotesText } from "./project-ops.js";
import { syncedPeers } from "./sync-base.js";
import { hashFileSync, writeBundleFile } from "./stream.js";
import { deviceName } from "../vault-ingest.js";

export const BUNDLE_FORMAT = "obsidian-memory-export";
export const BUNDLE_FORMAT_VERSION = 1;

export const MACHINE_LOCAL_DIRS = new Set(["template-backups", "import-conflicts"]);
const OS_LITTER = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "Icon\r"]);
const OBSIDIAN_SKIP = /^(?:workspace(?:-mobile)?\.json|workspaces\.json|cache)$/u;
export const LAYA_FILES = /^(?:labels[^/]*\.jsonl|recall-head\.json|durable-head\.json)$/u;
export const TEXT_EXT = /\.(?:md|markdown|txt|ya?ml|json|jsonl|canvas|base|csv)$/iu;

export function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * The Vault files to export: [{ rel, abs, size }], every exported folder [rel] (so empty ones such as
 * inbox/assets or checkpoints are recreated), plus skipped [{ rel, reason }].
 * projects: null for every project, else the ids to keep (20-Projects/<id>); withGlobal: include 10-Global.
 */
export function collectVaultFiles(vaultPath, { projects = null, exclude = [], withGlobal = true, withObsidianConfig = false } = {}) {
  const excluded = new Set(exclude);
  const files = [];
  const dirs = [];
  const skipped = [];
  const keep = projects ? new Set(projects) : null;
  const walk = (dirAbs, dirRel) => {
    let names;
    try { names = fs.readdirSync(dirAbs).sort(); } catch (error) { skipped.push({ rel: dirRel || ".", reason: `unreadable (${error.code ?? error.message})` }); return; }
    for (const name of names) {
      const rel = dirRel ? `${dirRel}/${name}` : name;
      const abs = path.join(dirAbs, name);
      if (OS_LITTER.has(name) || /\.\d+\.tmp$/u.test(name)) continue;
      let st;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) { skipped.push({ rel, reason: "symbolic link" }); continue; }
      if (st.isDirectory()) {
        if (name === ".git" || name === ".trash") continue;
        if (!dirRel && name.startsWith(".")) {
          if (name !== ".obsidian") { skipped.push({ rel, reason: "another tool's folder" }); continue; }
          if (!withObsidianConfig) continue;
        }
        if (dirRel === ".obsidian" && OBSIDIAN_SKIP.test(name)) continue;
        if (keep && dirRel === "20-Projects" && !keep.has(name)) continue;
        if (dirRel === "20-Projects" && excluded.has(name)) continue;
        // This machine's maintenance leftovers (replaced templates, parked import copies) stay here.
        if (dirRel === "00-System" && MACHINE_LOCAL_DIRS.has(name)) continue;
        if (!withGlobal && !dirRel && name === "10-Global") continue;
        const reason = unsafeEntryReason(rel);
        if (reason) { skipped.push({ rel, reason: `name cannot be created on every system (${reason})` }); continue; }
        dirs.push(rel);
        walk(abs, rel);
        continue;
      }
      if (!st.isFile()) { skipped.push({ rel, reason: "not a regular file" }); continue; }
      if (dirRel === ".obsidian" && OBSIDIAN_SKIP.test(name)) continue;
      if (!dirRel && name.startsWith(".")) { skipped.push({ rel, reason: "hidden file" }); continue; }
      const reason = unsafeEntryReason(rel);
      if (reason) { skipped.push({ rel, reason: `name cannot be created on every system (${reason})` }); continue; }
      files.push({ rel, abs, size: st.size });
    }
  };
  walk(vaultPath, "");
  return { files, dirs, skipped };
}

const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["OpenAI/Anthropic-style key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/u],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/u],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["credential assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\b["']?\s*[:=]\s*["']?(?![<{$])[^\s"'`,;]{12,}/iu]
];

/** Lines that look like a credential value: [{ rel, line, kind }]. Values themselves are never returned. */
export function scanSecrets(rel, data) {
  if (!TEXT_EXT.test(rel) || data.length > 8 * 1024 * 1024) return [];
  const hits = [];
  const lines = data.toString("utf8").split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    for (const [kind, re] of SECRET_PATTERNS) {
      if (re.test(lines[i])) { hits.push({ rel, line: i + 1, kind }); break; }
    }
  }
  return hits;
}

function layaFiles(layaDir, { withDecisions }) {
  let names = [];
  try { names = fs.readdirSync(layaDir).sort(); } catch { return []; }
  return names
    .filter((n) => LAYA_FILES.test(n) || (withDecisions && n === "decisions.jsonl"))
    .map((n) => ({ rel: n, abs: path.join(layaDir, n) }))
    .filter((f) => { try { return fs.lstatSync(f.abs).isFile(); } catch { return false; } });
}

/**
 * Build the bundle in memory. Options:
 *   projects      null (all) or [ids] — a partial export; Laya data is then left out unless withLaya
 *   withGlobal    include 10-Global (default true; false to hand a single project to someone else)
 *   withLaya      default: true for a full export, false for a partial one
 *   withDecisions include ~/.laya/decisions.jsonl (every logged prompt)
 *   withObsidianConfig include .obsidian (minus workspace state; plugin settings may hold API keys)
 *   passphrase    encrypt the bundle
 * Returns { bundle: Buffer, manifest, skipped, secrets, encrypted }.
 */
/**
 * Everything an export needs, without holding the files: { manifest, items, report }. Each item is
 * { name, abs, size, sha256 } (streamed later), { name, data } (rewritten in memory: projects.yaml) or
 * { name, dir: true }. Text files are read once to scan them; binaries are only hashed in chunks.
 */
export function prepareExport(vaultPath, {
  projects = null, withGlobal = true, withLaya = undefined, withDecisions = false, withObsidianConfig = false,
  layaDir = layaHome(), now = new Date()
} = {}) {
  if (!fs.existsSync(path.join(vaultPath, PROJECTS_FILE)) && !fs.existsSync(path.join(vaultPath, "10-Global"))) {
    throw new Error(`${vaultPath} does not look like an Obsidian Memory Vault (no 00-System/projects.yaml or 10-Global)`);
  }
  const registryText = (() => { try { return fs.readFileSync(path.join(vaultPath, PROJECTS_FILE), "utf8"); } catch { return null; } })();
  const registered = registryText ? parseProjectsYaml(registryText) : [];
  if (projects) {
    const unknown = projects.filter((id) => !registered.some((p) => p.id === id) && !fs.existsSync(path.join(vaultPath, "20-Projects", id)));
    if (unknown.length) throw new Error(`unknown project id(s): ${unknown.join(", ")}`);
  }
  // Projects marked `transfer: local` in this Vault never leave this machine.
  const stays = localOnlyProjects(registered);
  if (projects?.some((id) => stays.includes(id))) throw new Error(`project(s) ${projects.filter((id) => stays.includes(id)).join(", ")} are marked to stay on this machine (omem projects local <id> --off to change that)`);
  // Laya labels record prompts without their project, so they cannot be filtered: left out when a
  // project stays here, unless asked for.
  const includeLaya = withLaya ?? (!projects && stays.length === 0);

  const { files, dirs, skipped } = collectVaultFiles(vaultPath, { projects, exclude: stays, withGlobal, withObsidianConfig });
  const items = [];
  const listed = [];
  const secrets = [];
  const mentions = [];
  let projectsInBundle = registered;
  let remotesAdded = [];
  for (const f of files) {
    const name = `vault/${f.rel}`;
    if (f.rel === PROJECTS_FILE.split(path.sep).join("/")) {
      // The copy in the bundle records each local checkout's Git remote, so the other machine can
      // recognise the same repository at a different path. The Vault itself is not changed.
      let text = fs.readFileSync(f.abs, "utf8");
      const filled = backfillRemotesText(text);
      text = filled.text;
      remotesAdded = filled.changes;
      if (projects) text = filterProjectsYaml(text, projects);
      if (stays.length) text = filterProjectsYaml(text, parseProjectsYaml(text).map((p) => p.id).filter((id) => !stays.includes(id)));
      projectsInBundle = parseProjectsYaml(text);
      const data = Buffer.from(text, "utf8");
      items.push({ name, data });
      listed.push({ path: name, size: data.length, sha256: sha256(data) });
      continue;
    }
    if (TEXT_EXT.test(f.rel) && f.size <= 8 * 1024 * 1024) {
      const data = fs.readFileSync(f.abs);
      secrets.push(...scanSecrets(name, data));
      // Other notes that point into a project that stays here would reveal its name or paths.
      const text = data.toString("utf8");
      for (const id of stays) {
        if (text.includes(`20-Projects/${id}/`) || text.includes(`20-Projects/${id}]`) || text.includes(`project_id: ${id}`) || text.includes(`project_id: "${id}"`)) mentions.push({ rel: name, project: id });
      }
      const item = { name, abs: f.abs, size: data.length, sha256: sha256(data) };
      items.push(item);
      listed.push({ path: name, size: item.size, sha256: item.sha256 });
      continue;
    }
    const size = fs.statSync(f.abs).size;
    const item = { name, abs: f.abs, size, sha256: hashFileSync(f.abs) };
    items.push(item);
    listed.push({ path: name, size, sha256: item.sha256 });
  }
  if (includeLaya) {
    for (const f of layaFiles(layaDir, { withDecisions })) {
      const data = fs.readFileSync(f.abs);
      items.push({ name: `laya/${f.rel}`, data });
      listed.push({ path: `laya/${f.rel}`, size: data.length, sha256: sha256(data) });
    }
  }
  const included = new Set(listed.filter((f) => f.path.startsWith("vault/")).map((f) => f.path.slice(6)));
  const onlyIncluded = (files) => Object.fromEntries(Object.entries(files).filter(([rel]) => included.has(rel)).map(([rel, h]) => [`vault/${rel}`, h]));
  const manifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    pluginVersion: pluginVersion(),
    createdAt: now.toISOString(),
    source: { platform: process.platform, vaultName: path.basename(vaultPath), device: deviceName() },
    scope: { projects: projects ?? "all", global: withGlobal, laya: includeLaya, decisions: includeLaya && withDecisions, obsidianConfig: withObsidianConfig },
    projects: projectsInBundle.map(({ id, scope, roots, remotes }) => ({ id, scope, roots, remotes })),
    dirs: dirs.map((d) => `vault/${d}`),
    files: listed,
    // Per other machine, the version of each file this one last agreed on with it (sync-base.js). The
    // importing machine reads its own entry, so a third machine never inherits another pair's agreement.
    syncedByDevice: Object.fromEntries(Object.entries(syncedPeers(vaultPath, { layaDir })).map(([device, files]) => [device, onlyIncluded(files)]))
  };
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {
    manifest,
    items: [{ name: "manifest.json", data: manifestData }, ...dirs.map((d) => ({ name: `vault/${d}`, dir: true })), ...items],
    report: { skipped, secrets, remotesAdded, keptHere: stays, mentions, layaLeftOut: !includeLaya && !projects && withLaya === undefined }
  };
}

/** The bundle in memory (tests, small Vaults). Large Vaults use exportToFile, which streams. */
export function buildExport(vaultPath, options = {}) {
  const { manifest, items, report } = prepareExport(vaultPath, options);
  const entries = items.map((i) => (i.dir || i.data ? i : { name: i.name, data: fs.readFileSync(i.abs) }));
  const tar = createTarGz(entries, { mtime: (options.now ?? new Date()).getTime() });
  const bundle = options.passphrase ? encryptBundle(tar, options.passphrase) : tar;
  return { bundle, manifest, ...report, encrypted: Boolean(options.passphrase) };
}

/** Stream the bundle to `file` (constant memory, any size). Returns the same report as buildExport. */
export async function exportToFile(vaultPath, file, options = {}) {
  const { manifest, items, report } = prepareExport(vaultPath, options);
  await writeBundleFile(file, items, { passphrase: options.passphrase ?? null, mtime: (options.now ?? new Date()).getTime() });
  return { bytes: fs.statSync(file).size, manifest, ...report, encrypted: Boolean(options.passphrase) };
}

export function defaultBundleName(now = new Date(), { encrypted = false } = {}) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `obsidian-memory-export-${stamp}.tar.gz${encrypted ? ".enc" : ""}`;
}
