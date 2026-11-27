#!/usr/bin/env node
/**
 * `omem projects`: see and maintain the Vault's project registry (00-System/projects.yaml) across machines.
 *
 *   omem projects [list] [--vault <path>] [--json]
 *       each project, its roots (marking the ones that exist on this machine) and Git remotes
 *   omem projects bind <project-id> [<dir>] [--vault <path>] [--yes]
 *       add this machine's checkout (dir's Git root, default the current directory) to an existing
 *       project, with its Git remotes; a dry run unless --yes
 *   omem projects backfill-remotes [--vault <path>] [--yes]
 *       record the Git remotes of every project checked out on this machine; a dry run unless --yes
 *   omem projects merge <from-id> <into-id> [--vault <path>] [--yes]
 *       the same code registered twice: move <from>'s notes into <into>, join its roots and remotes,
 *       remove the <from> entry (lib/vault-transfer/project-merge.js); a dry run unless --yes
 *
 * bind and backfill-remotes only add list items; merge is the one command that removes an entry.
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { backfillRemotes, bindProject, listProjects } from "../lib/vault-transfer/project-ops.js";
import { applyMerge, planMerge } from "../lib/vault-transfer/project-merge.js";
import { likelyDuplicates, parseProjectsYaml } from "../lib/vault-transfer/projects.js";
import { readProjectsText } from "../lib/vault-transfer/project-ops.js";

const USAGE = `Usage:
  omem projects [list] [--vault <path>] [--json]
  omem projects bind <project-id> [<dir>] [--vault <path>] [--yes]
  omem projects backfill-remotes [--vault <path>] [--yes]
  omem projects merge <from-id> <into-id> [--vault <path>] [--yes]
Without --yes, bind, backfill-remotes and merge only show what they would do.
`;

export function parseArgs(argv = []) {
  const opts = { command: "list", args: [], vaultPath: null, yes: false, json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else positional.push(a);
  }
  if (positional.length) opts.command = positional.shift();
  opts.args = positional;
  return opts;
}

export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, { cwd = process.cwd() } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { out.write(USAGE); return 0; }
  const vaultPath = opts.vaultPath ? path.resolve(opts.vaultPath) : resolveVaultPath();
  if (!vaultPath) { err.write("Error: Could not detect the Obsidian Vault. Pass --vault <absolute-path>.\n"); return 1; }

  if (opts.command === "list") {
    const projects = listProjects(vaultPath);
    if (!projects) { err.write(`Error: no 00-System/projects.yaml in ${vaultPath}.\n`); return 1; }
    if (opts.json) { out.write(JSON.stringify({ vault: vaultPath, projects }, null, 2) + "\n"); return 0; }
    out.write(`Vault: ${vaultPath}\n`);
    for (const p of projects) {
      out.write(`\n${p.id}  (${p.scope})${p.rootsHere.length ? "" : "  — not on this machine"}\n`);
      for (const r of p.roots) out.write(`  root   ${p.rootsHere.includes(r) ? "[here]" : "      "} ${r}\n`);
      for (const r of p.remotes) out.write(`  remote        ${r}\n`);
    }
    const dups = likelyDuplicates(parseProjectsYaml(readProjectsText(vaultPath) ?? ""));
    if (dups.length) {
      out.write("\nProbably the same project under two ids:\n");
      for (const d of dups) out.write(`  ${d.a} ~ ${d.b}: ${d.reasons.join(", ")}  (omem projects merge <from> <into>)\n`);
    }
    return 0;
  }

  if (opts.command === "merge") {
    const [from, into] = opts.args;
    if (!from || !into) { err.write(USAGE); return 1; }
    let plan;
    try { plan = planMerge(vaultPath, from, into); } catch (error) { err.write(`Error: ${error.message}\n`); return 1; }
    const verb = opts.yes ? "" : "would be ";
    out.write(`Merge ${from} -> ${into}${plan.emptySource ? ` (${from} has no notes)` : ""}\n`);
    out.write(`  ${plan.moved.length} file(s) ${verb}moved, ${plan.identical.length} identical ${verb}dropped, ${plan.logs.filter((l) => l.added).length} log(s) ${verb}merged, ${plan.conflicts.length} conflict(s)\n`);
    for (const c of plan.conflicts.slice(0, 20)) out.write(`  conflict ${c.rel}\n`);
    if (plan.conflicts.length) out.write(`  ${into}'s notes kept; moved copies ${verb}put in ${plan.conflictsDir}/ (README lists them)\n`);
    if (plan.discarded.length) out.write(`  seed file(s) of the empty project ${verb}dropped: ${plan.discarded.join(", ")}\n`);
    for (const r of plan.rootsAdded) out.write(`  root ${verb}added to ${into}: ${r}\n`);
    for (const r of plan.remotesAdded) out.write(`  remote ${verb}added to ${into}: ${r}\n`);
    if (plan.relinked.length) out.write(`  links ${verb}updated in ${plan.relinked.length} other note(s)\n`);
    out.write(`  ${from} ${verb}removed from projects.yaml and 20-Projects/\n`);
    if (!opts.yes) { out.write("Dry run: pass --yes to merge.\n"); return 0; }
    applyMerge(plan);
    out.write(`Merged. Recorded in 20-Projects/${into}/log.md.\n`);
    return 0;
  }

  if (opts.command === "bind") {
    const [id, dir = cwd] = opts.args;
    if (!id) { err.write(USAGE); return 1; }
    const r = bindProject(vaultPath, id, path.resolve(cwd, dir), { apply: opts.yes });
    if (!r.ok) { err.write(`Error: ${r.error}\n`); return 1; }
    if (!r.changed) { out.write(`${r.root} is already bound to ${id}; nothing to add.\n`); return 0; }
    for (const root of r.addRoots) out.write(`${opts.yes ? "Added" : "Would add"} root   ${root}\n`);
    for (const remote of r.addRemotes) out.write(`${opts.yes ? "Added" : "Would add"} remote ${remote}\n`);
    out.write(opts.yes ? `Project ${id} updated.\n` : "Dry run: pass --yes to write 00-System/projects.yaml.\n");
    return 0;
  }

  if (opts.command === "backfill-remotes") {
    const r = backfillRemotes(vaultPath, { apply: opts.yes });
    if (r.error) { err.write(`Error: ${r.error}\n`); return 1; }
    for (const c of r.changes) for (const u of c.add) out.write(`${opts.yes ? "Added" : "Would add"} ${c.id}: ${u}\n`);
    for (const s of r.skipped) out.write(`Skipped ${s.id}: ${s.remote} (${s.reason})\n`);
    if (!r.changes.length) out.write("Every project checked out here already records its Git remotes.\n");
    else if (!opts.yes) out.write("Dry run: pass --yes to write 00-System/projects.yaml.\n");
    return 0;
  }

  err.write(`Unknown projects command: ${opts.command}\n${USAGE}`);
  return 1;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) process.exit(main());
