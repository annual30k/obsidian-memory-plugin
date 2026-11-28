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
import { openBundle, openBundleFile } from "./import.js";
import { PROJECTS_FILE, filterProjectsYaml, localOnlyProjects, parseProjectsYaml } from "./projects.js";
import { backfillRemotesText } from "./project-ops.js";
import {
  ancestorsFromBundle, computeFilesDigest, layaHashesFromEntries, readSyncedLaya, syncHash, syncedPeers
} from "./sync-base.js";
import { hashFileSync, hashTextFileNormalizedSync, writeBundleFile } from "./stream.js";
import { deviceName } from "../vault-ingest.js";

export const BUNDLE_FORMAT = "obsidian-memory-export";
export const FULL_BUNDLE_FORMAT_VERSION = 1;
export const INCREMENTAL_BUNDLE_FORMAT_VERSION = 2;
export const BUNDLE_FORMAT_VERSION = INCREMENTAL_BUNDLE_FORMAT_VERSION;

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
export function looksLikeBundlePath(value) {
  if (typeof value !== "string" || !value) return false;
  return /[\\/]/u.test(value) || /\.(?:tar\.gz|tgz|enc)$/iu.test(value);
}

function baselineFromOpened(opened, label) {
  const laya = layaHashesFromEntries(opened.entries);
  for (const u of opened.manifest.incremental?.layaUnchanged ?? []) {
    if (u?.name && u?.sha256 && !laya[u.name]) laya[u.name] = u.sha256;
  }
  return {
    kind: "bundle",
    files: ancestorsFromBundle(opened),
    laya,
    device: opened.manifest.source?.device ?? null,
    createdAt: opened.manifest.createdAt ?? null,
    bundleId: opened.manifest.incremental?.snapshotDigest ?? null,
    label: label ?? "previous bundle"
  };
}

/** Stream-open a previous bundle file as an incremental export baseline (constant memory). */
export async function loadSinceBundle(file, { passphrase = null } = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`baseline bundle not found: ${file}`);
  const opened = await openBundleFile(abs, { passphrase });
  return baselineFromOpened(opened, `bundle "${path.basename(abs)}"`);
}

function resolveBaselineSync(vaultPath, { incremental = false, full = false, since = null, sincePassphrase = null, layaDir = layaHome() } = {}) {
  if (full) {
    return {
      active: false,
      fallbackReason: incremental || since ? "--full specified; exporting a full bundle" : null,
      baseline: null
    };
  }
  if (!incremental && !since) return { active: false, fallbackReason: null, baseline: null };
  if (since && typeof since === "object" && !Buffer.isBuffer(since) && since.files) {
    return { active: true, fallbackReason: null, baseline: since };
  }
  if (Buffer.isBuffer(since)) {
    return { active: true, fallbackReason: null, baseline: baselineFromOpened(openBundle(since, { passphrase: sincePassphrase ?? null }), "previous bundle") };
  }
  if (typeof since === "string") {
    const abs = path.resolve(since);
    let isFile = false;
    try { isFile = fs.statSync(abs).isFile(); } catch {}
    if (isFile) {
      const opened = openBundle(fs.readFileSync(abs), { passphrase: sincePassphrase ?? null });
      return { active: true, fallbackReason: null, baseline: baselineFromOpened(opened, `bundle "${path.basename(abs)}"`) };
    }
    if (looksLikeBundlePath(since)) throw new Error(`baseline bundle not found: ${since}`);
    const peers = syncedPeers(vaultPath, { layaDir });
    const files = peers[since];
    if (files && Object.keys(files).length > 0) {
      return {
        active: true,
        fallbackReason: null,
        baseline: {
          kind: "device",
          device: since,
          files,
          laya: readSyncedLaya(vaultPath, { layaDir, peer: since }),
          label: `device "${since}"`
        }
      };
    }
    return {
      active: false,
      fallbackReason: `no sync baseline for device "${since}" yet; exporting a full bundle`,
      baseline: null
    };
  }
  // incremental === true without explicit --since
  const peers = syncedPeers(vaultPath, { layaDir });
  const deviceNames = Object.keys(peers).filter((d) => Object.keys(peers[d]).length > 0).sort();
  if (deviceNames.length === 0) {
    return {
      active: false,
      fallbackReason: "no sync baseline recorded for this Vault yet; exporting a full bundle",
      baseline: null
    };
  }
  if (deviceNames.length === 1) {
    const dev = deviceNames[0];
    return {
      active: true,
      fallbackReason: null,
      baseline: {
        kind: "device",
        device: dev,
        files: peers[dev],
        laya: readSyncedLaya(vaultPath, { layaDir, peer: dev }),
        label: `device "${dev}"`
      }
    };
  }
  throw new Error(`multiple synced devices found (${deviceNames.join(", ")}); pass --since <device> (or --since <bundle>, or --full)`);
}

/**
 * Everything an export needs, without holding the files: { manifest, items, report }. Each item is
 * { name, abs, size, sha256 } (streamed later), { name, data } (rewritten in memory: projects.yaml) or
 * { name, dir: true }. Text files are read once to scan them; binaries are only hashed in chunks.
 */
export function prepareExport(vaultPath, {
  projects = null, withGlobal = true, withLaya = undefined, withDecisions = false, withObsidianConfig = false,
  incremental = false, full = false, since = null, sincePassphrase = null,
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

  const resolvedBase = resolveBaselineSync(vaultPath, { incremental, full, since, sincePassphrase, layaDir });
  const baselineActive = resolvedBase.active;
  const baseline = resolvedBase.baseline;

  const { files, dirs, skipped } = collectVaultFiles(vaultPath, { projects, exclude: stays, withGlobal, withObsidianConfig });
  const items = [];
  const listed = [];
  const unchanged = [];
  const allVaultPairs = [];
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
      const rawHash = sha256(data);
      const sHash = syncHash(f.rel, data);
      allVaultPairs.push([name, sHash]);
      if (baselineActive && baseline.files[f.rel] === sHash) {
        unchanged.push({ path: name, size: data.length, sha256: rawHash, syncHash: sHash });
      } else {
        items.push({ name, data });
        listed.push({ path: name, size: data.length, sha256: rawHash });
      }
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
      const rawHash = sha256(data);
      const sHash = syncHash(f.rel, data);
      allVaultPairs.push([name, sHash]);
      if (baselineActive && baseline.files[f.rel] === sHash) {
        unchanged.push({ path: name, size: data.length, sha256: rawHash, syncHash: sHash });
      } else {
        const item = { name, abs: f.abs, size: data.length, sha256: rawHash };
        items.push(item);
        listed.push({ path: name, size: item.size, sha256: item.sha256 });
      }
      continue;
    }
    const size = fs.statSync(f.abs).size;
    const rawHash = hashFileSync(f.abs);
    const sHash = TEXT_EXT.test(f.rel) ? hashTextFileNormalizedSync(f.abs) : rawHash;
    allVaultPairs.push([name, sHash]);
    if (baselineActive && baseline.files[f.rel] === sHash) {
      unchanged.push({ path: name, size, sha256: rawHash, syncHash: sHash });
    } else {
      const item = { name, abs: f.abs, size, sha256: rawHash };
      items.push(item);
      listed.push({ path: name, size, sha256: item.sha256 });
    }
  }
  const layaUnchanged = [];
  if (includeLaya) {
    for (const f of layaFiles(layaDir, { withDecisions })) {
      const data = fs.readFileSync(f.abs);
      const rawHash = sha256(data);
      if (baselineActive && baseline.laya?.[f.rel] === rawHash) {
        layaUnchanged.push({ name: f.rel, sha256: rawHash });
        continue;
      }
      items.push({ name: `laya/${f.rel}`, data });
      listed.push({ path: `laya/${f.rel}`, size: data.length, sha256: rawHash });
    }
  }
  const included = new Set([
    ...listed.filter((f) => f.path.startsWith("vault/")).map((f) => f.path.slice(6)),
    ...unchanged.map((u) => u.path.slice(6))
  ]);
  const onlyIncluded = (files) => Object.fromEntries(Object.entries(files).filter(([rel]) => included.has(rel)).map(([rel, h]) => [`vault/${rel}`, h]));
  const manifest = {
    format: BUNDLE_FORMAT,
    formatVersion: baselineActive ? INCREMENTAL_BUNDLE_FORMAT_VERSION : FULL_BUNDLE_FORMAT_VERSION,
    bundleType: baselineActive ? "incremental" : "full",
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
  let incrementalReport = null;
  if (baselineActive) {
    const changedVaultCount = listed.filter((f) => f.path.startsWith("vault/")).length;
    const unchangedBytes = unchanged.reduce((sum, u) => sum + u.size, 0);
    manifest.incremental = {
      baseKind: baseline.kind,
      baseDevice: baseline.device ?? null,
      baseBundleCreatedAt: baseline.createdAt ?? null,
      baseBundleId: baseline.bundleId ?? null,
      baseDigest: computeFilesDigest(unchanged.map((u) => [u.path, u.syncHash])),
      changedCount: changedVaultCount,
      unchangedCount: unchanged.length,
      unchangedBytes,
      snapshotDigest: computeFilesDigest(allVaultPairs),
      layaUnchanged
    };
    manifest.unchanged = unchanged;
    incrementalReport = { ...manifest.incremental, baseLabel: baseline.label };
  }
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {
    manifest,
    items: [{ name: "manifest.json", data: manifestData }, ...dirs.map((d) => ({ name: `vault/${d}`, dir: true })), ...items],
    report: {
      skipped, secrets, remotesAdded, keptHere: stays, mentions,
      layaLeftOut: !includeLaya && !projects && withLaya === undefined,
      bundleType: manifest.bundleType,
      incremental: incrementalReport,
      fallbackReason: resolvedBase.fallbackReason
    }
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
  let effectiveOptions = options;
  if (!options.full && typeof options.since === "string") {
    const abs = path.resolve(options.since);
    let isFile = false;
    try { isFile = fs.statSync(abs).isFile(); } catch {}
    if (isFile) {
      const baseObj = await loadSinceBundle(abs, { passphrase: options.sincePassphrase ?? options.passphrase ?? null });
      effectiveOptions = { ...options, since: baseObj };
    }
  }
  const { manifest, items, report } = prepareExport(vaultPath, effectiveOptions);
  await writeBundleFile(file, items, { passphrase: options.passphrase ?? null, mtime: (options.now ?? new Date()).getTime() });
  return { bytes: fs.statSync(file).size, manifest, ...report, encrypted: Boolean(options.passphrase) };
}

export function defaultBundleName(now = new Date(), { encrypted = false, incremental = false } = {}) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const prefix = incremental ? "obsidian-memory-incremental" : "obsidian-memory-export";
  return `${prefix}-${stamp}.tar.gz${encrypted ? ".enc" : ""}`;
}
