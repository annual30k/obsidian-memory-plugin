#!/usr/bin/env node
/**
 * `omem export`: pack the Vault (and your Laya labels and trained heads) into one file for another machine.
 *
 *   omem export [--vault <path>] [--out <file>|<dir>] [--project <id>]... [--no-global]
 *               [--no-laya | --with-laya] [--with-decisions] [--with-obsidian-config]
 *               [--encrypt [--passphrase-file <file>]] [--json]
 *
 * The Vault is only read. The bundle's copy of 00-System/projects.yaml records each local checkout's Git
 * remote so the other machine recognises the same repositories at other paths. Import it there with
 * `omem import <file>`.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { defaultBundleName, exportToFile } from "../lib/vault-transfer/export.js";
import { getPassphrase } from "../lib/vault-transfer/passphrase.js";

const USAGE = `Usage: omem export [--vault <path>] [--out <file-or-dir>] [options]
  --project <id>          export only this project (repeatable); Laya data is then left out unless --with-laya
  --no-global             leave out 10-Global (e.g. to hand one project to someone else)
  --no-laya / --with-laya leave out / include ~/.laya labels and trained heads
  --with-decisions        also include ~/.laya/decisions.jsonl (every logged prompt; private)
  --with-obsidian-config  include .obsidian (plugin settings there may contain API keys)
  --encrypt               encrypt with a passphrase (OBSIDIAN_MEMORY_PASSPHRASE, --passphrase-file, or prompt)
  --json                  print the result as JSON
`;

export function parseArgs(argv = []) {
  const opts = {
    vaultPath: null, out: null, projects: [], withGlobal: true, withLaya: undefined, withDecisions: false,
    withObsidianConfig: false, encrypt: false, passphraseFile: null, json: false, help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if ((a === "--out" || a === "-o") && argv[i + 1]) opts.out = argv[++i];
    else if (a === "--project" && argv[i + 1]) opts.projects.push(argv[++i]);
    else if (a === "--no-global") opts.withGlobal = false;
    else if (a === "--no-laya") opts.withLaya = false;
    else if (a === "--with-laya") opts.withLaya = true;
    else if (a === "--with-decisions") opts.withDecisions = true;
    else if (a === "--with-obsidian-config") opts.withObsidianConfig = true;
    else if (a === "--encrypt") opts.encrypt = true;
    else if (a === "--passphrase-file" && argv[i + 1]) { opts.passphraseFile = argv[++i]; opts.encrypt = true; }
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function outputPath(out, encrypted, now) {
  const name = defaultBundleName(now, { encrypted });
  if (!out) return path.resolve(name);
  const abs = path.resolve(out);
  try { if (fs.statSync(abs).isDirectory()) return path.join(abs, name); } catch {}
  return abs;
}

const kb = (n) => n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { err.write(`Error: ${error.message}\n${USAGE}`); return 1; }
  if (opts.help) { out.write(USAGE); return 0; }
  const vaultPath = opts.vaultPath ? path.resolve(opts.vaultPath) : (deps.resolveVaultPath ?? resolveVaultPath)();
  if (!vaultPath) { err.write("Error: Could not detect the Obsidian Vault. Pass --vault <absolute-path>.\n"); return 1; }
  const now = deps.now ?? new Date();
  try {
    const passphrase = opts.encrypt ? await (deps.getPassphrase ?? getPassphrase)({ file: opts.passphraseFile, confirm: true }) : null;
    const file = outputPath(opts.out, Boolean(passphrase), now);
    if (path.resolve(file).startsWith(path.resolve(vaultPath) + path.sep)) throw new Error("write the bundle outside the Vault (it would be exported next time)");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Streamed to the file: memory stays flat however large the attachments are.
    const result = await exportToFile(vaultPath, file, {
      projects: opts.projects.length ? opts.projects : null, withGlobal: opts.withGlobal, withLaya: opts.withLaya,
      withDecisions: opts.withDecisions, withObsidianConfig: opts.withObsidianConfig, passphrase, now,
      ...(deps.layaDir ? { layaDir: deps.layaDir } : {})
    });
    result.bundle = { length: result.bytes };
    const vaultFiles = result.manifest.files.filter((f) => f.path.startsWith("vault/")).length;
    const layaFiles = result.manifest.files.filter((f) => f.path.startsWith("laya/")).map((f) => f.path.slice(5));
    if (opts.json) {
      out.write(JSON.stringify({ file, bytes: result.bundle.length, encrypted: result.encrypted, vaultFiles, layaFiles,
        projects: result.manifest.projects.map((p) => p.id), keptHere: result.keptHere, mentions: result.mentions, remotesAdded: result.remotesAdded, skipped: result.skipped, secrets: result.secrets }, null, 2) + "\n");
      return 0;
    }
    out.write(`Exported ${vaultPath}\n  -> ${file} (${kb(result.bundle.length)}${result.encrypted ? ", encrypted" : ""})\n`);
    out.write(`  ${vaultFiles} Vault files, ${result.manifest.projects.length} projects; Laya data: ${layaFiles.length ? layaFiles.join(", ") : "none"}\n`);
    for (const c of result.remotesAdded) out.write(`  recorded Git remote for ${c.id}: ${c.add.join(", ")}\n`);
    if (result.remotesAdded.length) out.write("  (in the bundle only; `omem projects backfill-remotes --yes` records them in this Vault too)\n");
    for (const s of result.skipped) out.write(`  left out ${s.rel}: ${s.reason}\n`);
    if (result.keptHere.length) {
      out.write(`  kept on this machine (transfer: local): ${result.keptHere.join(", ")}\n`);
      if (result.layaLeftOut) out.write("  Laya labels left out: they record prompts without their project, so they may include ones about a project that stays here (--with-laya to include them)\n");
    }
    if (result.mentions.length) {
      out.write(`\nWarning: ${result.mentions.length} exported note(s) mention a project that stays on this machine (its name or paths travel with them):\n`);
      for (const m of result.mentions.slice(0, 20)) out.write(`  ${m.rel} (${m.project})\n`);
      out.write("Remove those mentions first if the project's name must not leave this machine.\n");
    }
    if (result.secrets.length) {
      out.write(`\nWarning: ${result.secrets.length} line(s) look like credentials (values not shown):\n`);
      for (const s of result.secrets.slice(0, 20)) out.write(`  ${s.rel}:${s.line} (${s.kind})\n`);
      if (result.secrets.length > 20) out.write(`  … and ${result.secrets.length - 20} more\n`);
      out.write("Check them before sharing the bundle; --encrypt protects it in transit.\n");
    }
    if (!result.encrypted) out.write("\nThe bundle is not encrypted: anyone with the file can read your memory. Use --encrypt to send it over a chat app or cloud drive.\n");
    out.write(`\nOn the other machine: omem import "${path.basename(file)}" --vault <folder>\n`);
    return 0;
  } catch (error) {
    err.write(`Error: ${error.message}\n`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) main().then((code) => process.exit(code));
