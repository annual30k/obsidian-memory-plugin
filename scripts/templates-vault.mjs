#!/usr/bin/env node
/**
 * `omem templates`: check and install the Vault's note templates (00-System/templates/) from this plugin,
 * byte for byte, so every machine and host uses the same ones.
 *
 *   omem templates [status] [--vault <path>] [--json]
 *   omem templates install [--vault <path>] [--yes]       add missing templates only (initialization)
 *   omem templates update  [--vault <path>] [--replace-custom] [--yes]
 *       add missing and upgrade never-edited older ones; --replace-custom also replaces edited or
 *       hand-written ones after copying them to 00-System/template-backups/<time>/
 *
 * install and update are dry runs without --yes. Notes are never changed.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { VAULT_TEMPLATE_DIR, templateStatus, updateTemplates } from "../lib/vault-templates.js";
import { exitAfterFlush } from "../lib/exit-after-flush.js";

const USAGE = `Usage:
  omem templates [status] [--vault <path>] [--json]
  omem templates install [--vault <path>] [--yes]
  omem templates update [--vault <path>] [--replace-custom] [--yes]
install adds missing templates; update also upgrades unedited older ones, and with --replace-custom
replaces edited or hand-written ones (backed up first). Without --yes nothing is written.
`;

const LABEL = {
  current: "current",
  outdated: "older plugin version, never edited",
  custom: "edited or hand-written; has every core field",
  incompatible: "edited or hand-written; missing core fields",
  missing: "missing"
};

export function parseArgs(argv = []) {
  const opts = { command: "status", vaultPath: null, yes: false, replaceCustom: false, json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--replace-custom") opts.replaceCustom = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (!a.startsWith("-")) positional.push(a);
    else throw new Error(`unknown option ${a}`);
  }
  if (positional.length) opts.command = positional[0];
  return opts;
}

function describe(t) {
  const extra = t.state === "outdated" ? ` (${t.versions[0]}${t.versions.length > 1 ? `–${t.versions.at(-1)}` : ""})`
    : t.state === "incompatible" ? `: ${[...t.missingFields.map((f) => `no ${f}`), ...t.problems].join("; ")}` : "";
  return `${t.name.padEnd(28)} ${LABEL[t.state]}${extra}`;
}

export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { err.write(`Error: ${error.message}\n${USAGE}`); return 1; }
  if (opts.help) { out.write(USAGE); return 0; }
  const vaultPath = opts.vaultPath ? path.resolve(opts.vaultPath) : (deps.resolveVaultPath ?? resolveVaultPath)();
  if (!vaultPath) { err.write("Error: Could not detect the Obsidian Vault. Pass --vault <absolute-path>.\n"); return 1; }
  if (!fs.existsSync(vaultPath)) { err.write(`Error: ${vaultPath} does not exist.\n`); return 1; }

  if (opts.command === "status") {
    const status = templateStatus(vaultPath);
    if (opts.json) { out.write(JSON.stringify({ vault: vaultPath, templates: status }, null, 2) + "\n"); return 0; }
    out.write(`Templates in ${path.join(vaultPath, ...VAULT_TEMPLATE_DIR.split("/"))}:\n`);
    for (const t of status) out.write(`  ${describe(t)}\n`);
    const todo = status.filter((t) => t.state !== "current");
    if (!todo.length) { out.write("All templates are current.\n"); return 0; }
    const safe = todo.filter((t) => t.state === "missing" || t.state === "outdated").length;
    const custom = todo.length - safe;
    if (safe) out.write(`\n'omem templates update --yes' adds or upgrades ${safe} template(s) without touching edited ones.\n`);
    if (custom) out.write(`${custom} edited or hand-written template(s) are kept unless you add --replace-custom (they are backed up first).\n`);
    return 0;
  }

  if (opts.command === "install" || opts.command === "update") {
    const plan = updateTemplates(vaultPath, { apply: opts.yes, replaceCustom: opts.replaceCustom, onlyMissing: opts.command === "install" });
    if (opts.json) { out.write(JSON.stringify({ vault: vaultPath, applied: opts.yes, ...plan }, null, 2) + "\n"); return 0; }
    const verb = opts.yes ? "" : "would be ";
    const lines = [
      ...plan.add.map((n) => `  ${verb}added     ${n}`),
      ...plan.upgrade.map((n) => `  ${verb}upgraded  ${n}`),
      ...plan.replace.map((n) => `  ${verb}replaced  ${n}`)
    ];
    if (!lines.length) out.write("Nothing to change.\n");
    else out.write(lines.join("\n") + "\n");
    if (plan.backupDir) out.write(`  replaced templates ${verb}backed up to ${plan.backupDir}/\n`);
    for (const t of plan.keep) out.write(`  kept      ${describe(t)}\n`);
    if (plan.keep.some((t) => t.state === "incompatible") && !opts.replaceCustom && opts.command === "update") {
      out.write("Templates missing core fields produce notes that Lint and the digest cannot use fully; --replace-custom swaps them (backed up first).\n");
    }
    if (lines.length && !opts.yes) out.write("Dry run: pass --yes to write.\n");
    return 0;
  }

  err.write(`Unknown templates command: ${opts.command}\n${USAGE}`);
  return 1;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) exitAfterFlush(main());
