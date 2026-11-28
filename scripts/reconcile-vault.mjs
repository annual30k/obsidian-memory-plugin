#!/usr/bin/env node
/**
 * `omem reconcile`: pages written on another machine from candidates this Vault already ingested. An
 * import parks them in 00-System/import-conflicts/<time>/same-ingest/<original path>; the agent folds
 * what they add into the local page, then records the fold here so both machines converge.
 *
 *   omem reconcile [--vault <path>] [--json]                 list parked pages and the local pages to fold into
 *   omem reconcile fold <parked copy> --into <page> [--yes]  record the fold (00-System/reconciliation.jsonl)
 *                                                            and delete the parked copy
 *
 * The ledger travels with the Vault: the other machine then drops its copy of the folded page (when it is
 * unchanged) instead of sending it back, and a re-import does not park it again.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { CONFLICTS_DIR } from "../lib/vault-transfer/import.js";
import { LEDGER_REL, SAME_INGEST_DIR, citedCandidates, localIngestState, textHash } from "../lib/vault-transfer/reconcile.js";
import { deviceName } from "../lib/vault-ingest.js";

const USAGE = `Usage:
  omem reconcile [--vault <path>] [--json]
  omem reconcile fold <parked copy> --into <vault-relative page> [--vault <path>] [--yes]
Fold first (merge what the parked page adds into the local page), then run fold to record it.
`;

export function parseArgs(argv = []) {
  const opts = { command: "list", args: [], into: null, vaultPath: null, yes: false, json: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if (a === "--into" && argv[i + 1]) opts.into = argv[++i];
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length) opts.command = positional.shift();
  opts.args = positional;
  return opts;
}

const posix = (p) => p.split(path.sep).join("/");

/** Every parked copy: [{ copy, original, candidates, localPages }]. */
export function parkedPages(vaultPath) {
  const out = [];
  const root = path.join(vaultPath, ...CONFLICTS_DIR.split("/"));
  let runs = [];
  try { runs = fs.readdirSync(root); } catch { return out; }
  const state = localIngestState(vaultPath);
  for (const run of runs.sort()) {
    const base = path.join(root, run, SAME_INGEST_DIR);
    const walk = (dir) => {
      let names;
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) walk(abs);
        else if (name.endsWith(".md")) {
          const candidates = citedCandidates(fs.readFileSync(abs, "utf8"));
          out.push({
            copy: posix(path.relative(vaultPath, abs)), original: posix(path.relative(base, abs)), candidates,
            localPages: [...new Set(candidates.flatMap((id) => state.citedBy[id] ?? []))]
          });
        }
      }
    };
    walk(base);
  }
  return out;
}

function removeEmptyDirs(dir, stop) {
  let d = dir;
  while (d.startsWith(stop) && d !== stop) {
    try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    d = path.dirname(d);
  }
}

export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { err.write(`Error: ${error.message}\n${USAGE}`); return 1; }
  if (opts.help) { out.write(USAGE); return 0; }
  const vaultPath = opts.vaultPath ? path.resolve(opts.vaultPath) : (deps.resolveVaultPath ?? resolveVaultPath)();
  if (!vaultPath) { err.write("Error: Could not detect the Obsidian Vault. Pass --vault <absolute-path>.\n"); return 1; }

  if (opts.command === "list") {
    const parked = parkedPages(vaultPath);
    if (opts.json) { out.write(JSON.stringify(parked, null, 2) + "\n"); return 0; }
    if (!parked.length) { out.write("Nothing to reconcile.\n"); return 0; }
    for (const p of parked) {
      out.write(`${p.copy}\n  written elsewhere as ${p.original} from ${p.candidates.join(", ")}\n  fold into: ${p.localPages.length ? p.localPages.join(", ") : "(no local page cites these candidates; it can be moved to its original path instead)"}\n`);
    }
    out.write("\nMerge what each parked page adds into the local page, then: omem reconcile fold <parked copy> --into <page> --yes\n");
    return 0;
  }

  if (opts.command === "fold") {
    const [copyArg] = opts.args;
    if (!copyArg || !opts.into) { err.write(USAGE); return 1; }
    const copyAbs = path.resolve(vaultPath, copyArg);
    const copyRel = posix(path.relative(vaultPath, copyAbs));
    const m = new RegExp(`^${CONFLICTS_DIR.replace(/\//gu, "\\/")}\\/[^/]+\\/${SAME_INGEST_DIR}\\/(.+\\.md)$`, "u").exec(copyRel);
    if (!m || !fs.existsSync(copyAbs)) { err.write(`Error: ${copyArg} is not a parked page under ${CONFLICTS_DIR}/<time>/${SAME_INGEST_DIR}/\n`); return 1; }
    const into = posix(opts.into).replace(/^\/+/u, "");
    if (!fs.existsSync(path.join(vaultPath, ...into.split("/")))) { err.write(`Error: ${into} does not exist in the Vault\n`); return 1; }
    const entry = { folded: m[1], hash: textHash(fs.readFileSync(copyAbs, "utf8")), into, at: new Date().toISOString(), device: deviceName() };
    if (!opts.yes) { out.write(`Would record: ${m[1]} folded into ${into}, and delete ${copyRel}.\nDry run: pass --yes.\n`); return 0; }
    const ledger = path.join(vaultPath, ...LEDGER_REL.split("/"));
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify(entry) + "\n");
    fs.rmSync(copyAbs);
    removeEmptyDirs(path.dirname(copyAbs), path.join(vaultPath, ...CONFLICTS_DIR.split("/")));
    out.write(`Recorded: ${m[1]} folded into ${into}. The other machine drops its copy on its next import from this Vault.\n`);
    return 0;
  }

  err.write(`Unknown reconcile command: ${opts.command}\n${USAGE}`);
  return 1;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) process.exit(main());
