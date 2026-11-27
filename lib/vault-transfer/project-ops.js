/**
 * Changes to 00-System/projects.yaml made on the user's request: bind this machine's checkout to an
 * existing project, and record Git remotes so other machines recognise the same repository.
 * Every change only adds list items; ids, other roots, comments and unknown keys stay as they were.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PROJECTS_FILE, addToProjectList, findGitRoot, gitRemotes, parseProjectsYaml, resolveProject
} from "./projects.js";

export function projectsPath(vaultPath) {
  return path.join(vaultPath, PROJECTS_FILE);
}

export function readProjectsText(vaultPath) {
  try { return fs.readFileSync(projectsPath(vaultPath), "utf8"); } catch { return null; }
}

/** Write through a temporary file in the same folder so a crash never leaves half a registry. */
export function writeProjectsText(vaultPath, text) {
  const file = projectsPath(vaultPath);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function physical(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** Each project with where it lives on this machine. */
export function listProjects(vaultPath) {
  const text = readProjectsText(vaultPath);
  if (text === null) return null;
  return parseProjectsYaml(text).map((p) => {
    const here = p.roots.filter((r) => path.isAbsolute(r) && fs.existsSync(r));
    return { id: p.id, scope: p.scope, roots: p.roots, remotes: p.remotes, rootsHere: here };
  });
}

/**
 * Plan (and with apply: write) binding `dir` to project `id`: its Git root (or the directory itself) is
 * added to roots, its normalized remotes to remotes. Refuses when the directory already belongs to
 * another project by root, or when that root is already registered elsewhere.
 * Returns { ok, id, root, addRoots, addRemotes, error?, changed }.
 */
export function bindProject(vaultPath, id, dir, { apply = false } = {}) {
  const text = readProjectsText(vaultPath);
  if (text === null) return { ok: false, error: "no 00-System/projects.yaml in this Vault" };
  const projects = parseProjectsYaml(text);
  const project = projects.find((p) => p.id === id);
  if (!project) return { ok: false, error: `no project with id ${id}` };
  if (typeof dir !== "string" || !dir || !fs.existsSync(dir)) return { ok: false, error: `directory not found: ${dir}` };
  const root = physical(findGitRoot(dir) ?? dir);
  const current = resolveProject(projects, root);
  if (current?.via === "root" && current.id !== id) {
    return { ok: false, error: `${root} already belongs to project ${current.id}` };
  }
  const addRoots = project.roots.some((r) => path.isAbsolute(r) && physical(r) === root) ? [] : [root];
  const known = new Set(project.remotes.map((r) => r.toLowerCase()));
  const addRemotes = gitRemotes(root).remotes.filter((r) => !known.has(r));
  for (const remote of addRemotes) {
    const other = projects.find((p) => p.id !== id && p.remotes.some((r) => r.toLowerCase() === remote));
    if (other) return { ok: false, error: `remote ${remote} is already recorded for project ${other.id}` };
  }
  let next = addToProjectList(text, id, "roots", addRoots);
  next = addToProjectList(next, id, "remotes", addRemotes);
  const changed = next !== text;
  if (apply && changed) writeProjectsText(vaultPath, next);
  return { ok: true, id, root, addRoots, addRemotes, changed };
}

/**
 * For every project with a root on this machine that is its own Git checkout, record its remotes in
 * `text` (projects.yaml content). A remote that two projects would share is skipped (it could not
 * identify either). Returns { text, changes: [{ id, add }], skipped: [{ id, remote, reason }] }.
 */
export function backfillRemotesText(text) {
  const projects = parseProjectsYaml(text);
  const found = new Map();
  for (const p of projects) {
    const remotes = new Set();
    for (const r of p.roots) {
      if (!path.isAbsolute(r) || !fs.existsSync(r)) continue;
      const git = gitRemotes(r);
      // Only the project's own repository: a root inside a bigger checkout is not identified by its remote.
      if (git.root && physical(git.root) === physical(r)) for (const u of git.remotes) remotes.add(u);
    }
    found.set(p.id, remotes);
  }
  const owners = new Map();
  for (const p of projects) {
    for (const u of [...p.remotes.map((r) => r.toLowerCase()), ...found.get(p.id)]) {
      if (!owners.has(u)) owners.set(u, new Set());
      owners.get(u).add(p.id);
    }
  }
  const changes = [];
  const skipped = [];
  let next = text;
  for (const p of projects) {
    const known = new Set(p.remotes.map((r) => r.toLowerCase()));
    const add = [];
    for (const u of found.get(p.id)) {
      if (known.has(u)) continue;
      if (owners.get(u).size > 1) { skipped.push({ id: p.id, remote: u, reason: "shared by several projects" }); continue; }
      add.push(u);
    }
    if (add.length) {
      next = addToProjectList(next, p.id, "remotes", add);
      changes.push({ id: p.id, add });
    }
  }
  return { text: next, changes, skipped };
}

/** backfillRemotesText on the Vault's registry; writes it only with apply. */
export function backfillRemotes(vaultPath, { apply = false } = {}) {
  const text = readProjectsText(vaultPath);
  if (text === null) return { changes: [], skipped: [], changed: false, error: "no 00-System/projects.yaml in this Vault" };
  const r = backfillRemotesText(text);
  const changed = r.text !== text;
  if (apply && changed) writeProjectsText(vaultPath, r.text);
  return { changes: r.changes, skipped: r.skipped, changed };
}
