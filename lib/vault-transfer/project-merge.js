/**
 * Merge one project into another (`omem projects merge <from> <into>`), for the same code registered
 * twice, typically once per machine. On the user's explicit request only; a dry run unless applied.
 *
 *   20-Projects/<from>/<path>   moved to 20-Projects/<into>/<path>; links "20-Projects/<from>/" and a
 *                               frontmatter `project_id: <from>` in the moved notes are rewritten (the
 *                               note's identity moves with it; its content is otherwise untouched)
 *     same file already there   identical (line endings ignored): dropped
 *     log.md                    entries the target lacks are appended
 *     anything else             target kept; the moved copy goes to
 *                               00-System/import-conflicts/<time>-merge-<from>/ for the agent to merge
 *   a project with no notes     its seed files (AGENTS, rules, index) are dropped instead of parked
 *   other notes of the Vault    links to 20-Projects/<from>/ are rewritten to the target
 *   projects.yaml               <from>'s roots and remotes join <into>; the <from> entry is removed
 *   <into>/log.md               one "maintenance" entry records the merge
 */

import fs from "node:fs";
import path from "node:path";
import { CONFLICTS_DIR, mergeLog } from "./import.js";
import { addToProjectList, parseProjectsYaml, removeProjectEntry } from "./projects.js";
import { readProjectsText, writeProjectsText } from "./project-ops.js";
import { normalizeEol } from "../vault-templates.js";

const SEEDS = new Set(["AGENTS.md", "rules.md", "index.md"]);
const TEXT = /\.(?:md|markdown|txt|ya?ml|json|jsonl|canvas|base|csv)$/iu;

function stamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Every file and folder under dir: { files: [rel], dirs: [rel] } with "/" separators. Symlinks are refused. */
function walk(dir) {
  const files = [];
  const dirs = [];
  const go = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) throw new Error(`${r} is a symbolic link; merge it by hand`);
      if (st.isDirectory()) { dirs.push(r); go(a, r); } else if (st.isFile()) files.push(r);
    }
  };
  if (fs.existsSync(dir)) go(dir, "");
  return { files, dirs };
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Rewrite links into the old project folder, and (in moved notes) the frontmatter project_id. */
export function rewriteProjectRefs(text, from, into, { frontmatter = false } = {}) {
  let out = text.replace(new RegExp(`20-Projects/${escape(from)}/`, "gu"), `20-Projects/${into}/`);
  if (frontmatter) {
    out = out.replace(/^(---\r?\n[\s\S]*?\r?\n---)/u, (head) => head.replace(
      new RegExp(`^(project_id:\\s*)(["']?)${escape(from)}\\2(\\s*)$`, "mu"), (m, k, q, tail) => `${k}${q}${into}${q}${tail}`));
  }
  return out;
}

function vaultNotes(vaultPath) {
  const out = [];
  const go = (abs, rel) => {
    let names;
    try { names = fs.readdirSync(abs); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const a = path.join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = fs.lstatSync(a); } catch { continue; }
      if (st.isDirectory()) go(a, r);
      else if (st.isFile() && /\.md$/iu.test(name)) out.push(r);
    }
  };
  go(vaultPath, "");
  return out;
}

/**
 * Work out a merge; nothing is written. Returns a plan for applyMerge with readable lists:
 * moved, identical, logs, conflicts, discarded, relinked, rootsAdded, remotesAdded, emptySource.
 */
export function planMerge(vaultPath, from, into, { now = new Date() } = {}) {
  if (!from || !into || from === into) throw new Error("give two different project ids: merge <from> <into>");
  const registry = readProjectsText(vaultPath);
  if (registry === null) throw new Error("no 00-System/projects.yaml in this Vault");
  const projects = parseProjectsYaml(registry);
  const src = projects.find((p) => p.id === from);
  const dst = projects.find((p) => p.id === into);
  if (!src) throw new Error(`no project with id ${from}`);
  if (!dst) throw new Error(`no project with id ${into}`);
  const fromDir = path.join(vaultPath, "20-Projects", from);
  const intoDir = path.join(vaultPath, "20-Projects", into);
  const { files, dirs } = walk(fromDir);
  const notes = files.filter((f) => /\.md$/iu.test(f) && !(SEEDS.has(f) || f === "log.md"));
  const emptySource = notes.length === 0;
  const conflictsRel = `${CONFLICTS_DIR}/${stamp(now)}-merge-${from}`;
  const plan = {
    vaultPath, from, into, emptySource, conflictsDir: null,
    moved: [], identical: [], logs: [], conflicts: [], discarded: [], relinked: [], dirs,
    rootsAdded: [], remotesAdded: [], ops: [], registry: null
  };

  for (const rel of files) {
    const srcAbs = path.join(fromDir, ...rel.split("/"));
    const dstAbs = path.join(intoDir, ...rel.split("/"));
    const raw = fs.readFileSync(srcAbs);
    const isText = TEXT.test(rel);
    const data = isText ? Buffer.from(rewriteProjectRefs(raw.toString("utf8"), from, into, { frontmatter: true }), "utf8") : raw;
    let existing = null;
    try { existing = fs.readFileSync(dstAbs); } catch {}
    if (existing === null) {
      plan.moved.push(rel);
      plan.ops.push({ write: dstAbs, data }, { remove: srcAbs });
    } else if (existing.equals(data) || (isText && normalizeEol(existing.toString("utf8")) === normalizeEol(data.toString("utf8")))) {
      plan.identical.push(rel);
      plan.ops.push({ remove: srcAbs });
    } else if (rel === "log.md") {
      const m = mergeLog(existing.toString("utf8"), data.toString("utf8"));
      plan.logs.push({ rel, added: m.added });
      if (m.added) plan.ops.push({ write: dstAbs, data: Buffer.from(m.text, "utf8") });
      plan.ops.push({ remove: srcAbs });
    } else if (emptySource && SEEDS.has(rel)) {
      plan.discarded.push(rel);
      plan.ops.push({ remove: srcAbs });
    } else {
      const copy = `${conflictsRel}/20-Projects/${into}/${rel}`;
      plan.conflicts.push({ rel: `20-Projects/${into}/${rel}`, copy });
      plan.ops.push({ write: path.join(vaultPath, ...copy.split("/")), data }, { remove: srcAbs });
    }
  }
  if (plan.conflicts.length) {
    plan.conflictsDir = conflictsRel;
    const readme = [
      "---", "title: Merge conflicts", "type: import-conflicts", `created: ${localDate(now)}`, "---", "",
      `# Merge conflicts: ${from} → ${into}`, "",
      `These notes of ${from} already existed in ${into} with different content. The ${into} note was kept;`,
      "the moved copy is beside this file under the same path. Merge each pair following the obsidian-memory",
      "Skill (update the canonical note, mark real contradictions, never rewrite Raw), then delete this folder.", "",
      ...plan.conflicts.map((c) => `- [[${c.rel.replace(/\.md$/u, "")}]] ← \`${c.copy}\``), ""
    ].join("\n");
    plan.ops.push({ write: path.join(vaultPath, ...conflictsRel.split("/"), "README.md"), data: Buffer.from(readme, "utf8") });
  }

  // Links from the rest of the Vault into the old folder.
  const prefix = `20-Projects/${from}/`;
  for (const rel of vaultNotes(vaultPath)) {
    if (rel.startsWith(prefix)) continue;
    const abs = path.join(vaultPath, ...rel.split("/"));
    const text = fs.readFileSync(abs, "utf8");
    if (!text.includes(prefix)) continue;
    plan.relinked.push(rel);
    plan.ops.push({ write: abs, data: Buffer.from(rewriteProjectRefs(text, from, into), "utf8") });
  }

  // Registry: the source's roots and remotes join the target, then its entry goes.
  plan.rootsAdded = src.roots.filter((r) => !dst.roots.includes(r));
  plan.remotesAdded = src.remotes.filter((r) => !dst.remotes.some((x) => x.toLowerCase() === r.toLowerCase()));
  let next = addToProjectList(registry, into, "roots", plan.rootsAdded);
  next = addToProjectList(next, into, "remotes", plan.remotesAdded);
  plan.registry = removeProjectEntry(next, from);
  return plan;
}

/** Carry out a plan from planMerge. Returns the number of files written. */
export function applyMerge(plan, { now = new Date() } = {}) {
  const intoDir = path.join(plan.vaultPath, "20-Projects", plan.into);
  for (const d of plan.dirs) fs.mkdirSync(path.join(intoDir, ...d.split("/")), { recursive: true });
  let written = 0;
  for (const op of plan.ops) {
    if (op.write) {
      fs.mkdirSync(path.dirname(op.write), { recursive: true });
      const tmp = `${op.write}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, op.data);
      fs.renameSync(tmp, op.write);
      written++;
    } else if (op.remove) {
      fs.rmSync(op.remove, { force: true });
    }
  }
  fs.rmSync(path.join(plan.vaultPath, "20-Projects", plan.from), { recursive: true, force: true });
  writeProjectsText(plan.vaultPath, plan.registry);
  // One log entry in the surviving project.
  const log = path.join(intoDir, "log.md");
  const entry = [
    `## [${localDate(now)}] maintenance | merged project ${plan.from} into ${plan.into}`, "",
    `- Moved ${plan.moved.length} file(s); ${plan.identical.length} identical dropped; ${plan.conflicts.length} conflict(s)${plan.conflictsDir ? ` in \`${plan.conflictsDir}\`` : ""}.`,
    ...(plan.rootsAdded.length ? [`- Roots added: ${plan.rootsAdded.map((r) => `\`${r}\``).join(", ")}.`] : []),
    ...(plan.relinked.length ? [`- Links updated in ${plan.relinked.length} other note(s).`] : []),
    ""
  ].join("\n");
  const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  fs.writeFileSync(log, `${before.replace(/\s*$/u, "")}${before ? "\n\n" : ""}${entry}`);
  return written;
}
