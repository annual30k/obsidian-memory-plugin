#!/usr/bin/env node
/**
 * `omem ingest`: the mechanical steps of an ingest the user asked for, so every machine writes the same
 * Raw and candidate bytes (lib/vault-ingest.js). The agent does the rest (compare with existing
 * knowledge, Wiki, index, the log entry) between the two steps.
 *
 *   omem ingest status   <candidate-id|path>... [--vault <path>] [--json]
 *   omem ingest freeze   <candidate-id|path>... [--vault <path>] [--yes] [--json]
 *   omem ingest complete <candidate-id|path>... [--vault <path>] [--yes] [--json]
 *
 * freeze and complete are dry runs without --yes.
 */
import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { citingNotes, completeCandidates, deviceName, freezeCandidates, rawRel, readCandidate, renderRaw } from "../lib/vault-ingest.js";
import { normalizeEol } from "../lib/vault-templates.js";
import { exitAfterFlush } from "../lib/exit-after-flush.js";

const USAGE = `Usage:
  omem ingest status   <candidate-id|path>... [--vault <path>] [--json]
  omem ingest freeze   <candidate-id|path>... [--vault <path>] [--yes]
  omem ingest complete <candidate-id|path>... [--vault <path>] [--yes]
freeze writes raw/raw-<id>.md from the candidate (the same bytes on every machine); complete, after the
Wiki/index/log work, marks the candidate ingested. Without --yes nothing is written.
`;

export function parseArgs(argv = []) {
  const opts = { command: null, ids: [], vaultPath: null, yes: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault" && argv[i + 1]) opts.vaultPath = argv[++i];
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (!opts.command) opts.command = a;
    else opts.ids.push(a);
  }
  return opts;
}

function statusOf(vaultPath, idOrPath) {
  const r = readCandidate(vaultPath, idOrPath);
  if (!r.cand) return { id: idOrPath, error: r.error };
  const c = r.cand;
  const raw = rawRel(c);
  const rawAbs = path.join(vaultPath, ...raw.split("/"));
  const rawState = !fs.existsSync(rawAbs) ? "missing" : (r.ok && normalizeEol(fs.readFileSync(rawAbs, "utf8")) === renderRaw(c) ? "frozen by omem" : "exists (written another way)");
  const log = (() => { try { return fs.readFileSync(path.join(vaultPath, ...c.scopeRel.split("/"), "log.md"), "utf8"); } catch { return ""; } })();
  return {
    id: c.id, candidate: c.rel, status: c.data.status ?? null, standard: r.ok, problem: r.ok ? null : r.error,
    raw, rawState, logMarker: new RegExp(`ingest_id:\\s*ingest-${c.id}\\b`, "u").test(log), citedBy: citingNotes(vaultPath, c.scopeRel, `raw-${c.id}`)
  };
}

export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { err.write(`Error: ${error.message}\n${USAGE}`); return 1; }
  if (opts.help) { out.write(USAGE); return 0; }
  if (!["status", "freeze", "complete"].includes(opts.command) || !opts.ids.length) { err.write(USAGE); return 1; }
  const vaultPath = opts.vaultPath ? path.resolve(opts.vaultPath) : (deps.resolveVaultPath ?? resolveVaultPath)();
  if (!vaultPath) { err.write("Error: Could not detect the Obsidian Vault. Pass --vault <absolute-path>.\n"); return 1; }

  if (opts.command === "status") {
    const rows = opts.ids.map((id) => statusOf(vaultPath, id));
    if (opts.json) { out.write(JSON.stringify(rows, null, 2) + "\n"); return 0; }
    for (const s of rows) {
      if (s.error) { out.write(`${s.id}: ${s.error}\n`); continue; }
      out.write(`${s.id}  (${s.candidate})\n  status ${s.status}; Raw ${s.rawState}; log marker ${s.logMarker ? "present" : "missing"}; cited by ${s.citedBy.length ? s.citedBy.join(", ") : "no derived note"}\n`);
      if (!s.standard) out.write(`  not standard: ${s.problem}\n`);
    }
    return 0;
  }

  const results = opts.command === "freeze"
    ? freezeCandidates(vaultPath, opts.ids, { apply: opts.yes })
    : completeCandidates(vaultPath, opts.ids, { apply: opts.yes });
  if (opts.json) { out.write(JSON.stringify({ applied: opts.yes, device: deviceName(), results }, null, 2) + "\n"); return results.some((r) => r.state === "blocked" || r.state === "refused") ? 2 : 0; }
  const verb = opts.yes ? "" : "would be ";
  for (const r of results) {
    if (r.state === "refused") out.write(`${r.id}: not frozen automatically: ${r.error}. Handle it by hand following the Skill, or fix the candidate first.\n`);
    else if (r.state === "blocked") out.write(`${r.id}: BLOCKED: ${r.error}.${opts.command === "freeze" ? " Report it to the user; do not overwrite." : ""}\n`);
    else if (opts.command === "freeze") out.write(`${r.id}: ${r.state === "already" ? "already frozen" : `${verb}frozen`} -> ${r.raw}${r.attachments?.length ? ` (+${r.attachments.length} attachment(s))` : ""}\n`);
    else out.write(`${r.id}: ${r.state === "already" ? "already ingested" : `${verb}marked ingested`}${r.citedBy.length ? "" : " (no derived note links its Raw: the log entry must say where it went)"}\n`);
  }
  if (opts.command === "freeze" && results.some((r) => r.state === "frozen" || r.state === "already")) {
    out.write(`\nIn each ingest log entry, under the heading, write:\n  ingest_id: ingest-<candidate-id>\n  ingested_on: ${deviceName()}\nThen run: omem ingest complete <candidate-id>... --yes\n`);
  }
  if (!opts.yes && results.some((r) => r.state === "frozen" || r.state === "completed")) out.write("Dry run: pass --yes to write.\n");
  return results.some((r) => r.state === "blocked" || r.state === "refused") ? 2 : 0;
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) exitAfterFlush(main());
