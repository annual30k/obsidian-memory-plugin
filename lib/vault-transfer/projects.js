/**
 * 00-System/projects.yaml: reading, line-preserving edits, and Git-remote identity.
 *
 * A project's `roots` are physical directories on one machine; the same Vault used on another machine
 * (copied, imported or synced) sees other paths for the same code. So a project may list roots from
 * several machines (a root that does not exist here simply never matches) and an optional `remotes` list:
 * normalized Git remote URLs ("github.com/owner/repo"). A working directory whose Git root is not
 * registered still resolves to a project when one of its remotes matches exactly one project.
 *
 *   projects:
 *     - id: example-1f6a88a6
 *       roots:
 *         - /Users/me/code/example
 *         - 'C:\Users\me\code\example'
 *       remotes:
 *         - github.com/me/example
 *       scope: private
 *
 * Edits keep every other line (comments, unknown keys, quoting) as it was.
 */

import fs from "node:fs";
import path from "node:path";

export const PROJECTS_FILE = path.join("00-System", "projects.yaml");

function unquote(value) {
  let v = String(value).trim();
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/u.exec(v);
  if (quoted) v = `${quoted[1]}${quoted[2]}${quoted[1]}`;
  else v = v.replace(/\s+#.*$/u, "").trim();
  // Quotes are stripped without escape processing, as every other reader of this file does, so a
  // Windows path written as "C:\temp\x" keeps its backslashes.
  if (v.length >= 2 && v.startsWith("\"") && v.endsWith("\"")) return v.slice(1, -1);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/gu, "'");
  return v;
}

/**
 * YAML scalar for a path or remote. Plain when safe; otherwise single-quoted, which has no backslash
 * escapes, so a Windows path reads back unchanged by every parser in this package.
 */
export function yamlScalar(value) {
  const v = String(value);
  if (/^[A-Za-z0-9_./~@+-][A-Za-z0-9_./~@+:-]*$/u.test(v) && !/:\s|:$/u.test(v)) return v;
  return `'${v.replace(/'/gu, "''")}'`;
}

/**
 * Parse the project list. Each entry: { id, roots, remotes, scope, line, end, lists }, where line/end are
 * the entry's 0-based line range and lists[key] = { keyLine, lastItemLine, inline, itemIndent }.
 */
export function parseProjectsYaml(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const projects = [];
  let current = null;
  let list = null;
  const close = (i) => { if (current) { current.end = i; projects.push(current); } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/u.test(line) || !line.trim()) continue;
    const id = /^(\s*)-\s+id:\s*(.+)$/u.exec(line);
    if (id) {
      close(i);
      current = { id: unquote(id[2]), roots: [], remotes: [], scope: "private", line: i, end: lines.length, indent: id[1].length, lists: {} };
      list = null;
      continue;
    }
    if (!current) continue;
    if (/^\S/u.test(line)) { close(i); current = null; list = null; continue; }
    const key = /^(\s+)([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line);
    if (key) {
      const [, indent, name, rest] = key;
      list = null;
      if (name === "roots" || name === "remotes") {
        const info = { keyLine: i, lastItemLine: i, inline: false, keyIndent: indent.length, itemIndent: indent.length + 2 };
        current.lists[name] = info;
        if (/^\[.*\]$/u.test(rest.trim())) {
          info.inline = true;
          current[name] = rest.trim().slice(1, -1).split(",").map(unquote).filter(Boolean);
        } else if (!rest.trim()) {
          list = name;
        }
      } else if (name === "scope") {
        current.scope = unquote(rest) || "private";
      }
      continue;
    }
    const item = /^(\s+)-\s+(.+)$/u.exec(line);
    if (item && list) {
      current[list].push(unquote(item[2]));
      current.lists[list].lastItemLine = i;
      current.lists[list].itemIndent = item[1].length;
    }
  }
  close(lines.length);
  return projects;
}

export function readProjects(vaultPath) {
  try {
    return parseProjectsYaml(fs.readFileSync(path.join(vaultPath, PROJECTS_FILE), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Add `values` to a project's `roots` or `remotes` list (skipping ones already there). Returns the new
 * text, or the same text when nothing was added. Throws when the project id is not in the file.
 */
export function addToProjectList(text, projectId, key, values) {
  const eol = /\r\n/u.test(text) ? "\r\n" : "\n";
  const projects = parseProjectsYaml(text);
  const project = projects.find((p) => p.id === projectId);
  if (!project) throw new Error(`project ${projectId} is not in projects.yaml`);
  const existing = new Set(project[key].map((v) => key === "remotes" ? v.toLowerCase() : v));
  const fresh = [...new Set(values)].filter((v) => v && !existing.has(key === "remotes" ? v.toLowerCase() : v));
  if (fresh.length === 0) return text;
  const lines = text.split(/\r?\n/u);
  const info = project.lists[key];
  if (info && !info.inline) {
    const pad = " ".repeat(info.itemIndent);
    lines.splice(info.lastItemLine + 1, 0, ...fresh.map((v) => `${pad}- ${yamlScalar(v)}`));
    return lines.join(eol);
  }
  const keyIndent = info?.keyIndent ?? (project.lists.roots?.keyIndent ?? project.indent + 2);
  const pad = " ".repeat(keyIndent);
  const block = [`${pad}${key}:`, ...[...(info ? project[key] : []), ...fresh].map((v) => `${pad}  - ${yamlScalar(v)}`)];
  if (info) {
    lines.splice(info.keyLine, 1, ...block);
  } else {
    // A new list goes right after the roots list (or the id line), before scope and other keys.
    const roots = project.lists.roots;
    const after = roots ? (roots.inline ? roots.keyLine : roots.lastItemLine) : project.line;
    lines.splice(after + 1, 0, ...block);
  }
  return lines.join(eol);
}

/** Append a whole project entry (used by import for projects the target Vault does not have yet). */
export function appendProjectEntry(text, entry) {
  const eol = /\r\n/u.test(text) ? "\r\n" : "\n";
  const block = [`  - id: ${yamlScalar(entry.id)}`];
  const roots = entry.roots ?? [];
  block.push(roots.length ? "    roots:" : "    roots: []", ...roots.map((r) => `      - ${yamlScalar(r)}`));
  if (entry.remotes?.length) block.push("    remotes:", ...entry.remotes.map((r) => `      - ${yamlScalar(r)}`));
  block.push(`    scope: ${yamlScalar(entry.scope || "private")}`);
  let base = String(text ?? "");
  if (!/^projects:\s*(?:\[\s*\])?\s*$/mu.test(base)) base = (base.trimEnd() ? base.trimEnd() + eol : "") + "projects:" + eol;
  base = base.replace(/^projects:\s*\[\s*\]\s*$/mu, "projects:");
  return base.replace(/\s*$/u, "") + eol + block.join(eol) + eol;
}

/** Keep only the listed projects (header comments and the `projects:` line stay). */
export function filterProjectsYaml(text, keepIds) {
  const keep = new Set(keepIds);
  const lines = String(text ?? "").split(/\r?\n/u);
  const drop = new Set();
  for (const p of parseProjectsYaml(text)) {
    if (keep.has(p.id)) continue;
    for (let i = p.line; i < p.end; i++) drop.add(i);
  }
  return lines.filter((_, i) => !drop.has(i)).join(/\r\n/u.test(text) ? "\r\n" : "\n");
}

// ---------------------------------------------------------------- Git remotes

/**
 * "git@github.com:Owner/Repo.git", "https://user@github.com/owner/repo", "ssh://git@host:22/o/r.git"
 * -> "github.com/owner/repo". Local paths and file:// remotes are not portable identities: null.
 */
export function normalizeRemote(url) {
  if (typeof url !== "string") return null;
  let u = url.trim();
  if (!u || /^file:/iu.test(u) || /^[A-Za-z]:[\\/]/u.test(u) || u.startsWith("/") || u.startsWith(".") || u.startsWith("\\")) return null;
  let host;
  let rest;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/iu.exec(u);
  if (scheme) {
    host = scheme[2];
    rest = scheme[3] ?? "";
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/u.exec(u);
    if (!scp) return null;
    host = scp[1];
    rest = scp[2];
  }
  rest = rest.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "").replace(/\/+$/u, "");
  if (!host || !rest) return null;
  return `${host}/${rest}`.toLowerCase();
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/** The directory holding .git (walking up from `start`), or null. */
export function findGitRoot(start) {
  if (typeof start !== "string" || !start) return null;
  let dir = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    try {
      fs.statSync(path.join(dir, ".git"));
      return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** The repository's config file, following a `.git` file (worktree/submodule) and its commondir. */
function gitConfigPath(gitRoot) {
  const dotGit = path.join(gitRoot, ".git");
  let gitDir = dotGit;
  try {
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/mu.exec(readText(dotGit) ?? "");
      if (!m) return null;
      gitDir = path.resolve(gitRoot, m[1].trim());
    }
  } catch {
    return null;
  }
  const common = readText(path.join(gitDir, "commondir"));
  if (common && common.trim()) gitDir = path.resolve(gitDir, common.trim());
  return path.join(gitDir, "config");
}

/** Normalized identity remote(s) of the repository containing `dir`, read without running git. */
export function gitRemotes(dir) {
  const root = findGitRoot(dir);
  if (!root) return { root: null, remotes: [] };
  const config = readText(gitConfigPath(root) ?? "");
  if (!config) return { root, remotes: [] };
  const byName = [];
  let section = null;
  for (const line of config.split(/\r?\n/u)) {
    const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/u.exec(line);
    if (head) { section = head[1]; continue; }
    if (/^\s*\[/u.test(line)) { section = null; continue; }
    const url = section && /^\s*url\s*=\s*(.+?)\s*$/u.exec(line);
    if (url) {
      const n = normalizeRemote(url[1].replace(/^"|"$/gu, ""));
      if (n) byName.push({ name: section, url: n });
    }
  }
  // The repository's identity is its origin (or its only remote). Other remotes, such as a fork's
  // `upstream`, name a different repository and could tie this checkout to another project.
  const origin = byName.filter((r) => r.name === "origin");
  const names = new Set(byName.map((r) => r.name));
  const chosen = origin.length ? origin : (names.size === 1 ? byName : []);
  return { root, remotes: [...new Set(chosen.map((r) => r.url))] };
}

// ---------------------------------------------------------------- resolution

function physical(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function within(child, root) {
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a working directory to a project: the longest registered root containing it, else the one
 * project whose remotes include the directory's Git remote. Returns
 * { id, via: "root" | "remote", root?, gitRoot?, remote? } or null (none, or several projects share the remote).
 */
export function resolveProject(projects, cwd) {
  if (typeof cwd !== "string" || !cwd || !Array.isArray(projects)) return null;
  const abs = path.resolve(cwd);
  const cwds = [...new Set([abs, physical(abs)])];
  let best = null;
  for (const p of projects) {
    for (const r of p.roots) {
      if (!r || !path.isAbsolute(r)) continue;
      const rootPath = path.resolve(r);
      const roots = [...new Set([rootPath, physical(rootPath)])];
      if (cwds.some((c) => roots.some((x) => within(c, x))) && (!best || rootPath.length > best.root.length)) {
        best = { id: p.id, via: "root", root: rootPath };
      }
    }
  }
  if (best) return best;
  const withRemotes = projects.filter((p) => p.remotes.length > 0);
  if (withRemotes.length === 0) return null;
  const { root, remotes } = gitRemotes(abs);
  if (!root || remotes.length === 0) return null;
  for (const remote of remotes) {
    const matches = withRemotes.filter((p) => p.remotes.some((r) => r.toLowerCase() === remote));
    if (matches.length === 1) return { id: matches[0].id, via: "remote", gitRoot: physical(root), remote };
    if (matches.length > 1) return null;
  }
  return null;
}

// ---------------------------------------------------------------- duplicates and removal

/** "PocketClaw-d65c3b67" -> "pocketclaw": the id without its path-hash suffix, case-folded. */
export function projectStem(id) {
  return String(id).replace(/-[0-9a-f]{8}$/iu, "").toLowerCase();
}

/** Folder names of a project's roots, from any system's path spelling ("E:\\Project\\PocketClaw" -> "pocketclaw"). */
export function rootNames(project) {
  return [...new Set((project.roots ?? []).map((r) => String(r).split(/[\\/]+/u).filter(Boolean).at(-1)?.toLowerCase()).filter(Boolean))];
}

/**
 * Pairs of projects that are probably the same one registered twice (each machine onboarded the same
 * code under its own path, so under its own id): same id stem, a root folder of the same name, or a
 * shared remote. `among` limits the pairs to those involving one of these ids.
 * Returns [{ a, b, reasons: [...] }].
 */
export function likelyDuplicates(projects, { among = null } = {}) {
  const pairs = [];
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i];
      const b = projects[j];
      if (among && !among.includes(a.id) && !among.includes(b.id)) continue;
      const reasons = [];
      if (projectStem(a.id) && projectStem(a.id) === projectStem(b.id)) reasons.push(`same name "${projectStem(a.id)}"`);
      const folders = rootNames(a).filter((n) => rootNames(b).includes(n));
      if (folders.length && !reasons.length) reasons.push(`code folder named "${folders[0]}" in both`);
      const remotes = a.remotes.filter((r) => b.remotes.some((x) => x.toLowerCase() === r.toLowerCase()));
      if (remotes.length) reasons.push(`same remote ${remotes[0]}`);
      if (reasons.length) pairs.push({ a: a.id, b: b.id, reasons });
    }
  }
  return pairs;
}

/** projects.yaml without one project's entry (other lines unchanged). Throws when the id is not there. */
export function removeProjectEntry(text, projectId) {
  const project = parseProjectsYaml(text).find((p) => p.id === projectId);
  if (!project) throw new Error(`project ${projectId} is not in projects.yaml`);
  const eol = /\r\n/u.test(text) ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  lines.splice(project.line, project.end - project.line);
  return lines.join(eol);
}
