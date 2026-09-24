#!/usr/bin/env node
/**
 * Calibrate the Vault-hint thresholds on YOUR Vault. Read-only; nothing leaves the machine.
 *
 *   node scripts/calibrate-vault-hints.mjs --vault ~/Obsidian/Workspace --data my-vault-prompts.jsonl
 *
 * --data: JSON Lines {"text": "...", "recall": true|false, "projectId": "<id>"|null}
 *   recall:true  = a prompt the Vault has a note for (should match)
 *   recall:false = a prompt that should not pull notes
 * The bundled general negatives (tests/fixtures/laya-recall-*.jsonl, recall:false) are always added.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { buildVaultIndex, matchVault, resolveVaultPath } from "../lib/memory-router/vault-index.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const expand = (p) => (p && p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p);
const vault = expand(opt("--vault")) || resolveVaultPath();
if (!vault || !existsSync(vault)) {
  console.error("Vault not found; pass --vault <path>");
  process.exit(2);
}
const project = opt("--project");
const loadJsonl = (file) => readFileSync(file, "utf8").split(/\r?\n/u).filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((r) => r.label !== "context" && r.label !== "capture")
  .map((r) => (r.label ? { ...r, recall: r.label === "recall" } : r));

const rows = [];
if (opt("--data")) rows.push(...loadJsonl(resolve(expand(opt("--data")))).map((r) => ({ ...r, set: r.recall ? "vault+" : (r.hard ? "hard-" : "local-") })));
for (const f of ["laya-recall-eval.jsonl", "laya-recall-holdout.jsonl"]) {
  const file = fileURLToPath(new URL(`../tests/fixtures/${f}`, import.meta.url));
  for (const r of loadJsonl(file)) if (!r.recall) rows.push({ ...r, projectId: project, set: "general-" });
}

const t0 = performance.now();
const index = buildVaultIndex(vault);
const buildMs = performance.now() - t0;
console.log(`Indexed ${index.n} notes in ${buildMs.toFixed(0)} ms`);

const results = [];
const t1 = performance.now();
for (const row of rows) {
  const m = matchVault(index, row.text, { projectId: args.includes("--unscoped") ? null : (row.projectId ?? null) });
  results.push({ ...row, top: m.topScore, strength: m.strength, hit: m.hits[0]?.path ?? "", terms: m.hits[0]?.terms?.join(",") ?? "" });
}
const matchMs = (performance.now() - t1) / rows.length;

if (args.includes("--verbose")) {
  for (const r of results.sort((a, b) => a.set.localeCompare(b.set) || b.top - a.top)) {
    console.log(`${r.set.padEnd(9)} ${r.top.toFixed(2).padStart(6)} ${r.strength.padEnd(6)} ${r.text.slice(0, 40).padEnd(42)} ${r.hit.split("/").slice(-1)[0] ?? ""} [${r.terms}]`);
  }
}

const sets = [...new Set(results.map((r) => r.set))];
console.log(`\nmatch ${matchMs.toFixed(2)} ms/prompt`);
console.log("threshold  " + sets.map((s) => s.padStart(10)).join(" "));
for (let t = 2; t <= 12; t += 1) {
  const cells = sets.map((s) => {
    const rs = results.filter((r) => r.set === s);
    return `${rs.filter((r) => r.top >= t).length}/${rs.length}`.padStart(10);
  });
  console.log(`  >= ${String(t).padStart(2)}    ` + cells.join(" "));
}
