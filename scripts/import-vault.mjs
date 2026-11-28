#!/usr/bin/env node
/**
 * `omem import`: bring a bundle from `omem export` into a Vault on this machine.
 *
 *   omem import <bundle> [--vault <path>] [--map <project-id>=<dir>]... [--no-laya] [--replace-heads]
 *               [--passphrase-file <file>] [--yes] [--json]
 *
 * Without --yes it only shows the plan. An empty or missing folder receives the bundle as it is; an
 * existing Vault is merged without overwriting anything local (see lib/vault-transfer/import.js).
 * Afterwards it lists the hosts that still point at another Vault and the commands that repoint them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { isEncrypted } from "../lib/vault-transfer/archive.js";
import { applyImport, openBundleFile, planImport } from "../lib/vault-transfer/import.js";
import { ancestorsFromEntries } from "../lib/vault-transfer/sync-base.js";
import { getPassphrase } from "../lib/vault-transfer/passphrase.js";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: omem import <bundle> [--vault <path>] [options]
  --vault <path>             where to import (default: the Vault this machine's hosts use); an empty
                             or missing folder gets a fresh copy, an existing Vault is merged
  --map <project-id>=<dir>   where a project's code lives on this machine (repeatable)
  --no-laya                  leave ~/.laya untouched
  --replace-heads            use the bundle's trained Laya heads instead of the local ones
  --skip-project <id>        leave this project out entirely: its notes and its projects.yaml entry
                             (repeatable), e.g. private material that should stay on the other machine
  --base <older bundle>      the bundle both machines last started from (e.g. the export this Vault was
                             copied from): a file only one side changed since then is not a conflict.
                             Needed once for Vaults synced before 0.13.1; later imports remember it
  --use-incoming-templates   replace edited or hand-written local templates with the bundle's (backed up
                             first); unedited older templates are upgraded without it
  --passphrase-file <file>   passphrase of an encrypted bundle (or OBSIDIAN_MEMORY_PASSPHRASE, or a prompt)
  --yes                      apply; without it only the plan is shown
  --json                     print the plan as JSON
`;

export function parseArgs(argv = []) {
  const opts = { bundle: null, vaultPath: null, maps: {}, includeLaya: true, replaceHeads: false, useIncomingTemplates: false, base: null, skipProjects: [], passphraseFile: null, yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if (a === "--map" && argv[i + 1]) {
      const v = argv[++i];
      const eq = v.indexOf("=");
      if (eq <= 0 || eq === v.length - 1) throw new Error(`--map needs <project-id>=<dir>, got ${v}`);
      opts.maps[v.slice(0, eq)] = path.resolve(v.slice(eq + 1));
    }
    else if (a === "--no-laya") opts.includeLaya = false;
    else if (a === "--replace-heads") opts.replaceHeads = true;
    else if (a === "--use-incoming-templates") opts.useIncomingTemplates = true;
    else if (a === "--base" && argv[i + 1]) opts.base = argv[++i];
    else if (a === "--skip-project" && argv[i + 1]) opts.skipProjects.push(argv[++i]);
    else if (a === "--passphrase-file" && argv[i + 1]) opts.passphraseFile = argv[++i];
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-") && !opts.bundle) opts.bundle = a;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const STATUS = {
  here: "code found on this machine",
  mapped: "bound to the --map directory",
  "by-remote": "binds itself the first time you work in a checkout of",
  unbound: "not bound on this machine yet: pass --map <id>=<dir> or later run `omem projects bind <id> <dir>`",
  "no-code-root": "no code directory (topic project)",
  "map-missing": "--map directory not found",
  "map-conflict": "--map directory already belongs to another project"
};

async function passphraseFor(file, opts, deps) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(32);
  try { fs.readSync(fd, head, 0, 32, 0); } finally { fs.closeSync(fd); }
  return isEncrypted(head) ? (deps.getPassphrase ?? getPassphrase)({ file: opts.passphraseFile }) : null;
}

/** Hashes of an older bundle, streamed (no staging: only its text is kept in memory). */
async function loadBase(file, opts, deps) {
  const passphrase = await passphraseFor(file, opts, deps);
  return ancestorsFromEntries((await openBundleFile(file, { passphrase })).entries);
}

function hostsToRepoint(target, collect) {
  let report;
  try { report = collect(); } catch { return []; }
  const same = (p) => { try { return realpathSync(p) === realpathSync(target); } catch { return path.resolve(p) === path.resolve(target); } };
  const scripts = { OpenClaw: "setup-openclaw.mjs", Codex: "setup-codex.mjs", Antigravity: "setup-antigravity.mjs", Hermes: "setup-hermes.mjs" };
  return report.hosts
    .filter((h) => h.install?.installed && scripts[h.host] && !(h.vaults.length && h.vaults.every((v) => same(v.path))))
    .map((h) => ({
      host: h.host,
      vaults: [...new Set(h.vaults.map((v) => v.path))],
      command: `node "${path.join(SCRIPTS, scripts[h.host])}" --vault "${target}"${h.host === "OpenClaw" ? " --agent main" : ""} --yes`
    }));
}

function printPlan(plan, out, applied) {
  const m = plan.manifest;
  const v = plan.vault;
  out.write(`Bundle: created ${m.createdAt} on ${m.source?.platform ?? "?"} from Vault "${m.source?.vaultName ?? "?"}" (plugin ${m.pluginVersion ?? "?"})${plan.encrypted ? ", encrypted" : ""}\n`);
  if (plan.skipped?.projects.length) out.write(`Left out: project(s) ${plan.skipped.projects.join(", ")} (--skip-project)\n`);
  out.write(`Target: ${plan.target.path} (${{ missing: "new folder", empty: "empty folder", vault: "existing Vault, merging" }[plan.target.state]})\n\n`);
  const verb = applied ? "" : "would be ";
  out.write(`Vault files: ${v.add.length} ${verb}added, ${v.same.length} already identical, ${v.merged.length} log(s) ${verb}merged, ${v.conflicts.length} conflict(s), ${v.keptLocal.length} kept local${v.dirs.length ? `; ${v.dirs.length} folder(s) ${verb}created` : ""}\n`);
  if (v.fastForward.length || v.keptNewer.length || v.deletedHere.length || v.deletedThere.length) {
    out.write(`Changed on one side only since the last sync (ancestors from ${plan.sync.ancestors}):\n`);
    if (v.fastForward.length) out.write(`  ${v.fastForward.length} file(s) changed only on the other machine: ${verb}updated here\n`);
    for (const r of v.fastForward.slice(0, 15)) out.write(`    ${r}\n`);
    if (v.keptNewer.length) out.write(`  ${v.keptNewer.length} file(s) changed only here: kept\n`);
    if (v.deletedHere.length) out.write(`  ${v.deletedHere.length} file(s) deleted here since: not re-added\n`);
    if (v.deletedThere.length) out.write(`  ${v.deletedThere.length} file(s) the other machine no longer has: kept here (delete by hand if intended)\n`);
  }
  for (const x of v.merged) out.write(`  merged  ${x.rel} (+${x.added} entries)\n`);
  for (const c of v.conflicts.slice(0, 30)) out.write(`  conflict ${c.rel}\n`);
  if (v.conflicts.length > 30) out.write(`  … and ${v.conflicts.length - 30} more\n`);
  if (v.conflicts.length) out.write(`  Local notes kept; imported copies ${verb}put in ${plan.conflictsDir}/ (README lists them for the agent to merge).\n`);
  const ig = plan.ingest;
  if (ig && (ig.candidatesAdvanced.length || ig.rawSame.length || ig.logEntriesSkipped || ig.duplicates.length || ig.indexLines.length || ig.removedFolded.length || ig.alreadyFolded.length)) {
    out.write("\nIngests reconciled by candidate id:\n");
    if (ig.candidatesAdvanced.length) out.write(`  ${ig.candidatesAdvanced.length} candidate(s) ${verb}updated to the other machine's later status (ingested there)\n`);
    if (ig.rawSame.length) out.write(`  ${ig.rawSame.length} Raw note(s) frozen on both machines with the same evidence: kept local\n`);
    if (ig.logEntriesSkipped) out.write(`  ${ig.logEntriesSkipped} log entr${ig.logEntriesSkipped === 1 ? "y" : "ies"} for candidates already ingested here: not appended again\n`);
    for (const r of ig.removedFolded) out.write(`  ${r.rel} ${verb}removed: folded into ${r.into}${r.device ? ` on ${r.device}` : ""} (logged)\n`);
    if (ig.alreadyFolded.length) out.write(`  ${ig.alreadyFolded.length} page(s) already folded here earlier: skipped\n`);
    for (const x of ig.indexLines) out.write(`  ${x.rel}: ${x.added} line(s) for new pages ${verb}appended${x.removed ? `, ${x.removed} line(s) for removed pages ${verb}dropped` : ""} (local index kept)\n`);
    if (ig.duplicates.length) {
      out.write(`  ${ig.duplicates.length} page(s) written on the other machine from candidates already ingested here: not added; ${verb}parked in ${plan.conflictsDir}/same-ingest/ to fold into the local pages:\n`);
      for (const d of ig.duplicates.slice(0, 20)) out.write(`    ${d.rel} -> ${d.localPages.length ? d.localPages.join(", ") : "(no local page cites the same Raw)"}\n`);
    }
  }
  const tp = plan.templates;
  if (tp.upgraded.length || tp.replaced.length || tp.keptLocal.length) {
    out.write("\nTemplates (00-System/templates):\n");
    for (const n of tp.upgraded) out.write(`  ${verb}upgraded ${n} (local copy was an unedited older version)\n`);
    for (const r of tp.replaced) out.write(`  ${verb}replaced ${r.name} (local ${r.local}, backed up to ${tp.backupDir}/)\n`);
    for (const k of tp.keptLocal) {
      const issues = [...(k.missingFields.length ? [`lacks ${k.missingFields.join(", ")}`] : []), ...(k.problems ?? []).map((p) => p.replace(/ \(.*\)$/u, ""))];
      const why = k.local === "incompatible" ? `local one: ${issues.join("; ")}` : `local ${k.local}`;
      out.write(`  kept local ${k.name} (${why}; bundle has ${k.incoming})\n`);
    }
    if (tp.keptLocal.some((k) => k.local === "custom" || k.local === "incompatible") && !applied) {
      out.write("  --use-incoming-templates takes the bundle's for these (local ones backed up first); 'omem templates' checks them any time.\n");
    }
  }
  const pc = plan.projectChanges;
  if (pc) {
    if (pc.added.length) out.write(`\nProjects ${verb}added: ${pc.added.join(", ")}\n`);
    for (const e of pc.extended) out.write(`Project ${e.id}: ${[...e.roots.map((r) => `root ${r}`), ...e.remotes.map((r) => `remote ${r}`)].join(", ")} ${verb}added\n`);
    for (const s of pc.skipped) out.write(`Project ${s.id}: ${s.remote ? `remote ${s.remote} not copied (${s.reason}) — the two may be the same project kept under two ids` : s.reason}\n`);
  }
  if (plan.projects.length) {
    out.write("\nProjects on this machine:\n");
    for (const p of plan.projects) {
      const detail = p.status === "by-remote" ? `${STATUS[p.status]} ${p.remotes.join(", ")}` : STATUS[p.status];
      out.write(`  ${p.id}: ${detail}${p.root ? ` (${p.root})` : ""}\n`);
    }
  }
  if (plan.duplicates?.length) {
    out.write("\nProbably the same project under two ids (merge after importing, keeping the one with the notes):\n");
    for (const d of plan.duplicates) out.write(`  ${d.incoming} (imported) ~ ${d.local} (here): ${d.reasons.join(", ")}\n    omem projects merge <from> <into>   e.g. omem projects merge ${d.local} ${d.incoming}\n`);
  }
  const l = plan.laya;
  if (!l.skipped && (l.add.length || l.merged.length || l.keptLocal.length || l.same.length)) {
    out.write(`\nLaya data (${l.dir}):\n`);
    for (const n of l.add) out.write(`  ${verb}added  ${n}\n`);
    for (const n of l.merged) out.write(n.replaced ? `  ${verb}replaced ${n.name}\n` : `  ${verb}merged ${n.name} (+${n.added} lines)\n`);
    for (const n of l.keptLocal) out.write(`  kept local ${n} (differs; --replace-heads uses the imported one)\n`);
  }
  for (const r of plan.rejected) out.write(`Rejected ${r.name}: ${r.reason}\n`);
  for (const w of plan.warnings) out.write(`Warning: ${w}\n`);
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { err.write(`Error: ${error.message}\n${USAGE}`); return 1; }
  if (opts.help || !opts.bundle) { (opts.help ? out : err).write(USAGE); return opts.help ? 0 : 1; }
  const target = opts.vaultPath ? path.resolve(opts.vaultPath) : (deps.resolveVaultPath ?? resolveVaultPath)();
  if (!target) { err.write("Error: no Vault is configured on this machine; pass --vault <folder> (an empty folder for a fresh copy).\n"); return 1; }
  // The bundle is streamed into a private staging folder (removed at the end, whatever happens), so a
  // Vault with gigabytes of attachments imports without holding them in memory.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "omem-import-"));
  try {
    const bundleFile = path.resolve(opts.bundle);
    const passphrase = await passphraseFor(bundleFile, opts, deps);
    const opened = await openBundleFile(bundleFile, { passphrase, stagingDir: staging });
    const plan = planImport(opened, {
      targetVault: target, passphrase, maps: opts.maps, includeLaya: opts.includeLaya, replaceHeads: opts.replaceHeads,
      useIncomingTemplates: opts.useIncomingTemplates,
      base: opts.base ? await loadBase(path.resolve(opts.base), opts, deps) : null,
      skipProjects: opts.skipProjects,
      ...(deps.layaDir ? { layaDir: deps.layaDir } : {}), ...(deps.now ? { now: deps.now } : {})
    });
    if (opts.yes) {
      fs.mkdirSync(target, { recursive: true });
      applyImport(plan);
    }
    const collect = opts.yes ? (deps.collectHosts ?? (await import("./doctor.mjs")).collect) : null;
    const repoint = collect ? hostsToRepoint(target, collect) : [];
    if (opts.json) {
      const { writes, manifest, ...rest } = plan;
      out.write(JSON.stringify({ applied: opts.yes, writes: writes.length, manifest: { ...manifest, files: manifest.files.length }, ...rest, repoint }, null, 2) + "\n");
      return 0;
    }
    printPlan(plan, out, opts.yes);
    if (!opts.yes) {
      out.write(`\nDry run: nothing written (${plan.writes.length} file(s) would change). Re-run with --yes to import.\n`);
      return 0;
    }
    out.write(`\nImported: ${plan.writes.length} file(s) written.\n`);
    if (repoint.length) {
      out.write("\nThese hosts still use another Vault. To switch them to this one:\n");
      for (const r of repoint) out.write(`  ${r.host}${r.vaults.length ? ` (now ${r.vaults.join(", ")})` : ""}:\n    ${r.command}\n`);
    }
    out.write("\nNext: `omem index` embeds the imported notes for semantic hints (needs the Laya service).\n");
    if (plan.laya.merged.some((n) => n.name.startsWith("labels"))) out.write("Labels were merged: `laya train` retrains the recall head with them.\n");
    return 0;
  } catch (error) {
    err.write(`Error: ${error.message}\n`);
    return 1;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) main().then((code) => process.exit(code));
