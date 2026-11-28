#!/usr/bin/env node
/**
 * `omem`: the plugin's memory tools. None needs the Laya service except `index` (which embeds notes with
 * its retriever); the Laya service itself is managed with `laya` (install, start, status, label, train …).
 * Each subcommand forwards its arguments to the script `npm run omem:<name>` also runs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OMEM_COMMANDS = Object.freeze({
  export: "export-vault.mjs",
  import: "import-vault.mjs",
  projects: "projects-vault.mjs",
  templates: "templates-vault.mjs",
  ingest: "ingest-vault.mjs",
  reconcile: "reconcile-vault.mjs",
  search: "search-vault.mjs",
  index: "index-vault.mjs",
  doctor: "doctor.mjs",
  digest: "memory-digest.mjs",
  check: "check-vault.mjs"
});

export const OMEM_HELP = `omem — Obsidian Memory tools (the Laya service is managed with \`laya\`)

Move:    omem export             pack the Vault + your Laya labels/heads into one file (--encrypt, --project)
         omem import <file>      dry-run an import into this machine's Vault (--vault, --map id=dir, --yes)
         omem projects           list projects; bind <id> [dir] adds this machine's checkout; backfill-remotes
Vault:   omem templates          are the Vault's templates this plugin's? install | update [--replace-custom]
Ingest:  omem ingest freeze <id>  freeze a candidate into Raw (same bytes on every machine); complete <id> after Wiki/log
         omem reconcile          pages ingested on both machines, parked by an import; fold <copy> --into <page>
Recall:  omem search "<query>"   search Vault sections (file, ## section and line range)
         omem index              embed every Vault note now (needs the Laya service: laya start)
Capture: omem digest             stage Inbox candidates from finished sessions now (--now, --dry-run)
         omem digest --held      findings held because their session had no project
         omem digest --stats     what became of the digest's candidates
Check:   omem doctor             where each host is installed and which Vault it uses
         omem check [--vault]    read-only Vault health check (templates, links, scale, credentials)

Add --help to a command for its options.
`;

export function runOmem(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [first, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    stdout.write(OMEM_HELP);
    return first ? 0 : 1;
  }
  if (first === "--version" || first === "-v") {
    try { stdout.write(JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version + "\n"); } catch {}
    return 0;
  }
  if (!Object.hasOwn(OMEM_COMMANDS, first)) {
    stderr.write(`Unknown command: ${first}\n${["status", "start", "stop", "install", "uninstall", "label", "train", "eval", "tune", "bench"].includes(first) ? `(The Laya service and its model are managed with \`laya ${first}\`.)\n` : ""}\n${OMEM_HELP}`);
    return 1;
  }
  const script = fileURLToPath(new URL(`./${OMEM_COMMANDS[first]}`, import.meta.url));
  const result = spawnSync(process.execPath, [script, ...rest], { stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

let isMain = false;
try {
  isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
if (isMain) process.exit(runOmem());
