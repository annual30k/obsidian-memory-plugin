#!/usr/bin/env node
/**
 * Re-measure the semantic Vault-hint thresholds (DEFAULT_SEMANTIC_THRESHOLDS) on YOUR Vault.
 * Read-only for the Vault; needs the Laya service for embeddings; writes nothing to ~/.laya/cache.
 *
 *   node scripts/calibrate-vault-semantic.mjs [--vault <path>] [--negatives ~/.laya/labels-bootstrap.jsonl]
 *        [--positives my-vault-prompts.jsonl] [--project <id> ...] [--old-cache ~/.laya/cache/vault-embeddings.json]
 *
 * The thresholds were set as percentiles of the prominence (best note cosine minus median cosine) that
 * prompts NOT needing memory get: weak = 80th, strong = 97th. This prints those percentiles for the
 * current index (one vector per note, or the max over a long note's section chunks) and, when an older
 * single-vector cache is given, for that cache on the same notes, so the two layouts can be compared.
 *
 * --negatives: JSON Lines with "text" and "label" ("none" rows are used) or "recall": false.
 * --positives: JSON Lines {"text": "...", "projectId": "<id>"} of prompts a note exists for.
 * --project:   also measure scoped to that project (its notes plus Global), as the router does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryJudgeFromEnv } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import { buildVaultIndex, matchVaultSemantic, resolveVaultPath, DEFAULT_SEMANTIC_THRESHOLDS } from "../lib/memory-router/vault-index.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const opts = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const expand = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
const readJsonl = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const vault = expand(opt("--vault")) || resolveVaultPath();
if (!vault || !fs.existsSync(vault)) { console.error("Vault not found; pass --vault <path>"); process.exit(2); }
const negFile = expand(opt("--negatives")) || path.join(os.homedir(), ".laya", "labels-bootstrap.jsonl");
const oldCacheFile = expand(opt("--old-cache")) || path.join(os.homedir(), ".laya", "cache", "vault-embeddings.json");
const posFile = expand(opt("--positives"));

const negatives = readJsonl(negFile)
  .filter((r) => typeof r.text === "string" && r.text.trim() && (r.label ? r.label === "none" : r.recall === false))
  .map((r) => r.text);
const positives = posFile ? readJsonl(posFile).filter((r) => typeof r.text === "string") : [];
if (negatives.length < 50) { console.error(`Only ${negatives.length} negative prompts in ${negFile}; need 50+.`); process.exit(2); }

const router = createMemoryRouter(memoryJudgeFromEnv(process.env), { useCache: true });
async function embed(texts, kind) {
  const out = await router.embedTexts(texts, kind, { timeout: 30000 });
  if (!out?.vectors || out.vectors.length !== texts.length) throw new Error("Laya embeddings unavailable (is the service running?)");
  return out;
}

try {
  const index = buildVaultIndex(vault);
  const chunked = index.notes.filter((n) => Array.isArray(n.embedChunks)).length;
  console.log(`Vault: ${index.n} notes indexed, ${chunked} split into section chunks`);

  // Current layout: one vector per chunk, a note scores by its best chunk.
  const texts = index.notes.flatMap((n) => (n.embedChunks ?? [n.embedText]));
  const passages = await embed(texts, "passage");
  const model = passages.model;
  const current = { model, entries: {} };
  const firstOnly = { model, entries: {} };
  let k = 0;
  for (const note of index.notes) {
    const count = (note.embedChunks ?? [note.embedText]).length;
    const vecs = passages.vectors.slice(k, k + count);
    k += count;
    current.entries[note.path] = { hash: note.hash, v: vecs[0], ...(vecs.length > 1 ? { chunks: vecs } : {}) };
    firstOnly.entries[note.path] = { hash: note.hash, v: vecs[0] };
  }

  // Previous release's cache (vectors of the old one-text-per-note layout), re-keyed to today's hashes.
  let legacy = null;
  let legacyNote = "";
  try {
    const old = JSON.parse(fs.readFileSync(oldCacheFile, "utf8"));
    if (old.model === model && old.vaultPath === vault) {
      legacy = { model, entries: {} };
      for (const note of index.notes) {
        const v = old.entries?.[note.path]?.v;
        if (Array.isArray(v)) legacy.entries[note.path] = { hash: note.hash, v };
      }
      const covered = Object.keys(legacy.entries).length;
      legacyNote = `old cache covers ${covered}/${index.n} notes`;
      if (covered < index.n * 0.9) legacyNote += " (comparison less exact)";
    } else legacyNote = "old cache is for another model or Vault; skipped";
  } catch { legacyNote = `no old cache at ${oldCacheFile}`; }
  console.log(`Model: ${model}; ${legacyNote}\n`);

  const layouts = [
    ...(legacy ? [["old release (1 vector/note)", legacy]] : []),
    ["first chunk only", firstOnly],
    ["current (max over chunks)", current]
  ];
  // Compare layouts on the same notes: drop notes the old cache lacks.
  const sameNotes = legacy ? { ...index, notes: index.notes.filter((n) => legacy.entries[n.path]) } : index;

  const negVecs = (await embed(negatives, "query")).vectors;
  const posVecs = positives.length ? (await embed(positives.map((p) => p.text), "query")).vectors : [];
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const f3 = (x) => (typeof x === "number" ? x.toFixed(3) : "  -  ");

  const scopes = [null, ...opts("--project")];
  for (const projectId of scopes) {
    const label = projectId ? `scope: ${projectId}` : "scope: whole Vault";
    console.log(`=== ${negatives.length} prompts that need no memory, ${label}`);
    console.log("layout                          p50    p80    p90    p97   weak>=  strong>=");
    for (const [name, cache] of layouts) {
      const proms = negVecs.map((v) => matchVaultSemantic(sameNotes, cache, v, { projectId }))
        .filter((m) => m.candidates > 0 && typeof m.prominence === "number").map((m) => m.prominence).sort((a, b) => a - b);
      if (proms.length === 0) { console.log(`${name.padEnd(30)} (too few candidates)`); continue; }
      const weakRate = proms.filter((p) => p >= DEFAULT_SEMANTIC_THRESHOLDS.weak).length / proms.length;
      const strongRate = proms.filter((p) => p >= DEFAULT_SEMANTIC_THRESHOLDS.strong).length / proms.length;
      console.log(`${name.padEnd(30)} ${f3(pct(proms, 0.5))}  ${f3(pct(proms, 0.8))}  ${f3(pct(proms, 0.9))}  ${f3(pct(proms, 0.97))}  ${(weakRate * 100).toFixed(1).padStart(5)}%  ${(strongRate * 100).toFixed(1).padStart(6)}%`);
    }
    console.log("");
  }
  console.log(`Current thresholds: weak ${DEFAULT_SEMANTIC_THRESHOLDS.weak}, strong ${DEFAULT_SEMANTIC_THRESHOLDS.strong}` +
    " (set as the 80th / 97th percentile of such prompts on the author's Vault when first calibrated).\n");

  if (positives.length) {
    console.log(`=== ${positives.length} prompts a note exists for (scoped to their project)`);
    console.log("layout                          weak   strong  right note on top");
    for (const [name, cache] of layouts) {
      let weak = 0; let strong = 0; let right = 0;
      positives.forEach((p, i) => {
        const m = matchVaultSemantic(sameNotes, cache, posVecs[i], { projectId: p.projectId ?? null });
        if (m.prominence >= DEFAULT_SEMANTIC_THRESHOLDS.weak) weak++;
        if (m.prominence >= DEFAULT_SEMANTIC_THRESHOLDS.strong) strong++;
        const ok = Boolean(p.expect && m.hits[0]?.path?.includes(p.expect));
        if (ok) right++;
        if (args.includes("--verbose")) {
          console.log(`  ${ok ? "✓" : "✗"} ${f3(m.prominence)} ${p.text.slice(0, 24).padEnd(26)} -> ${(m.hits[0]?.path ?? "").split("/").pop()}`);
        }
      });
      const withExpect = positives.filter((p) => p.expect).length;
      console.log(`${name.padEnd(30)} ${String(weak).padStart(4)}   ${String(strong).padStart(5)}   ${withExpect ? `${right}/${withExpect}` : "-"}`);
    }
  }
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exitCode = 1;
} finally {
  router.dispose?.();
}
