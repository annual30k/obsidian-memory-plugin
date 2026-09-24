#!/usr/bin/env node
/**
 * Measure how well the recall router (Fast-Path + Laya) matches hand-labelled prompts.
 *
 * Requires a running Laya service (`npm run laya:start`). Prompts are sent only to
 * that local service. Usage:
 *   npm run laya:eval
 *   node scripts/eval-laya.mjs --data my-prompts.jsonl --json
 *
 * Dataset: JSON Lines, one object per line: {"text": "...", "recall": true|false}, optionally with
 * "label": "recall" | "capture" | "none" | "context". "context" rows (undecidable from the prompt alone)
 * are left out; "capture" counts as a turn that uses memory.
 * Label your own real prompts for the best signal; the bundled set is only a starting point.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseMemoryJudgeConfig } from "../lib/config.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { buildGuidance } from "../lib/prompt.js";

// Rough token estimate: ~1 token per CJK character, ~4 characters per token otherwise.
export function estimateTokens(text) {
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/gu) || []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}

/** Tokens a "skip" turn avoids: the skill file the agent would read plus the full guidance block, minus the skip block. */
export function skipSavingsPerTurn() {
  const skillPath = fileURLToPath(new URL("../skills/obsidian-memory/SKILL.md", import.meta.url));
  const cfg = { vaultPath: "/vault", cliPath: "obsidian" };
  const skill = estimateTokens(readFileSync(skillPath, "utf8"));
  const full = estimateTokens(buildGuidance(cfg));
  const skip = estimateTokens(buildGuidance(cfg, { score: 0, trace: { route: "laya" } }));
  return { skillTokens: skill, guidanceTokens: full, skipBlockTokens: skip, savedPerSkippedTurn: skill + full - skip };
}

const DEFAULT_DATA = fileURLToPath(new URL("../tests/fixtures/laya-recall-eval.jsonl", import.meta.url));
export const DEFAULT_THRESHOLDS = Array.from({ length: 13 }, (_, i) => Math.round((0.3 + i * 0.05) * 100) / 100);

export const LABELS = Object.freeze(["recall", "capture", "none", "context"]);

export function loadDataset(filePath) {
  const rows = [];
  readFileSync(filePath, "utf8").split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    const item = JSON.parse(line);
    if (typeof item.text !== "string" || !item.text.trim() || (typeof item.recall !== "boolean" && !LABELS.includes(item.label))) {
      throw new TypeError(`Invalid dataset line ${index + 1}: need {"text": string, "recall": boolean} or a "label" of ${LABELS.join("/")}`);
    }
    if (item.label !== undefined && !LABELS.includes(item.label)) {
      throw new TypeError(`Invalid dataset line ${index + 1}: label must be one of ${LABELS.join("/")}`);
    }
    if (item.label === "context") return;
    rows.push({
      text: item.text,
      recall: item.label ? item.label !== "none" : item.recall,
      ...(item.label ? { label: item.label } : {}),
      ...(typeof item.projectId === "string" ? { projectId: item.projectId } : {}),
      ...(typeof item.category === "string" ? { category: item.category } : {})
    });
  });
  return rows;
}

function score(pairs) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { predicted, actual } of pairs) {
    if (predicted && actual) tp++;
    else if (predicted && !actual) fp++;
    else if (!predicted && actual) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0;
  const accuracy = pairs.length ? (tp + tn) / pairs.length : null;
  return { n: pairs.length, tp, fp, fn, tn, precision, recall, f1, accuracy };
}

/** A turn "uses memory" when the router recommends recall or a capture (both load the memory skill). */
const usesMemory = (row) => Boolean(row.recallRecommended) || row.memoryAction === "capture";

/**
 * rows: [{ recall: boolean, route: "fast_path"|"laya"|"fallback", recallRecommended: boolean, score: number|null }]
 */
export function computeMetrics(rows, thresholds = DEFAULT_THRESHOLDS) {
  const routes = { fast_path: 0, laya: 0, fallback: 0 };
  for (const row of rows) routes[row.route] = (routes[row.route] ?? 0) + 1;

  const endToEnd = score(rows.map((row) => ({ predicted: usesMemory(row), actual: row.recall })));
  const layaRows = rows.filter((row) => row.route === "laya" && typeof row.score === "number");
  const sweep = thresholds.map((threshold) => ({
    threshold,
    ...score(layaRows.map((row) => ({ predicted: row.score >= threshold, actual: row.recall })))
  }));
  const best = layaRows.length
    ? sweep.reduce((a, b) => (b.f1 > a.f1 ? b : a))
    : null;
  const actions = { recall: 0, capture: 0, default: 0, skip: 0 };
  let wrongSkips = 0;
  for (const row of rows) {
    const action = row.memoryAction ?? (row.recallRecommended ? "recall" : "default");
    actions[action] = (actions[action] ?? 0) + 1;
    if (action === "skip" && row.recall) wrongSkips++;
  }
  const negatives = rows.filter((r) => !r.recall).length;
  const correctSkips = actions.skip - wrongSkips;
  const gating = {
    actions,
    skipShare: rows.length ? actions.skip / rows.length : null,
    // Of the prompts that did not need memory, how many were confidently skipped.
    skipCoverageOfNegatives: negatives ? correctSkips / negatives : null,
    // Prompts that needed memory but were told to skip it (the cost of gating).
    wrongSkips,
    wrongSkipRate: rows.length - negatives ? wrongSkips / (rows.length - negatives) : null
  };
  const byCategory = {};
  for (const row of rows) {
    if (typeof row.category !== "string") continue;
    const c = (byCategory[row.category] ??= { n: 0, correct: 0, wrongSkips: 0 });
    c.n++;
    if (usesMemory(row) === row.recall) c.correct++;
    if (row.memoryAction === "skip" && row.recall) c.wrongSkips++;
  }
  return { total: rows.length, routes, endToEnd, gating, layaOnly: { n: layaRows.length, sweep, best }, byCategory };
}

function parseArgs(argv) {
  const args = { data: DEFAULT_DATA, json: false, config: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data" && argv[i + 1]) args.data = resolve(argv[++i]);
    else if (arg === "--json") args.json = true;
    else if (arg === "--errors") args.errors = true;
    else if (arg === "--vault" && argv[i + 1]) args.vault = resolve(argv[++i].replace(/^~(?=\/)/u, homedir()));
    else if (arg === "--project" && argv[i + 1]) args.project = argv[++i];
    else if (arg === "--endpoint" && argv[i + 1]) args.config = { ...args.config, mode: "manual", endpoint: argv[++i] };
    else if (arg === "--service-file" && argv[i + 1]) args.config = { ...args.config, serviceFile: argv[++i] };
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

const pct = (value) => (value === null ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`);

export async function runEval(argv = process.argv.slice(2), { stdout = process.stdout, routerFactory = null } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write("Usage: node scripts/eval-laya.mjs [--data file.jsonl] [--vault /path/to/Vault [--project id]] [--endpoint http://127.0.0.1:PORT] [--service-file path] [--json] [--errors]\n");
    return 0;
  }
  if (!existsSync(args.data)) {
    stdout.write(`Dataset not found: ${args.data}\n`);
    return 2;
  }
  const dataset = loadDataset(args.data);
  // Long timeouts: this is an offline measurement, not a live hook.
  const config = parseMemoryJudgeConfig({ mode: "auto", timeout: 10000, coldStartTimeout: 60000, coldStart: "wait", healthTimeout: 2000, decisionLog: false, consecutiveFailures: 10, resetTimeout: 1000, ...args.config }); // recallThreshold: plugin default
  const router = routerFactory ? routerFactory(config) : new MemoryRouter(config, { useCache: false });

  const rows = [];
  try {
    for (const item of dataset) {
      // --vault: also apply the Vault-hint layer the host hooks use (no host => nothing is logged).
      const turn = args.vault ? { vaultPath: args.vault, projectId: item.projectId ?? args.project ?? null } : null;
      let result = await router.evaluateRecall(item.text, null, turn);
      // Offline measurement: retry a transient miss (model still loading after sleep, busy service)
      // once instead of recording it as a fallback.
      if (result.trace?.route === "fallback" && result.trace?.layaAttempted) {
        await new Promise((r) => setTimeout(r, 1500));
        result = await router.evaluateRecall(item.text, null, turn);
      }
      rows.push({ text: item.text, category: item.category, recall: item.recall, route: result.trace?.route ?? "fallback", boost: result.boost ?? null, recallRecommended: Boolean(result.recallRecommended), score: typeof result.score === "number" ? result.score : null, reason: result.reason, memoryAction: result.memoryAction });
    }
  } finally {
    router.dispose?.();
  }

  const metrics = computeMetrics(rows);
  const savings = skipSavingsPerTurn();
  if (args.json) {
    stdout.write(JSON.stringify({ ...metrics, savings, recallThreshold: config.recallThreshold, skipThreshold: config.skipThreshold }, null, 2) + "\n");
  } else {
    const e = metrics.endToEnd;
    stdout.write(`Prompts: ${metrics.total}  (fast_path ${metrics.routes.fast_path}, laya ${metrics.routes.laya}, fallback ${metrics.routes.fallback})\n`);
    stdout.write(`End-to-end @ recallThreshold ${config.recallThreshold}: precision ${pct(e.precision)}  recall ${pct(e.recall)}  F1 ${pct(e.f1)}  accuracy ${pct(e.accuracy)}\n`);
    const g = metrics.gating;
    stdout.write(`Actions: skip ${g.actions.skip}, default ${g.actions.default}, recall ${g.actions.recall}, capture ${g.actions.capture}  (skipThreshold ${config.skipThreshold})\n`);
    stdout.write(`Skipped ${pct(g.skipCoverageOfNegatives)} of prompts that did not need memory; wrongly skipped ${g.wrongSkips} that did (${pct(g.wrongSkipRate)})\n`);
    stdout.write(`Estimated tokens avoided per skipped turn: ~${savings.savedPerSkippedTurn} (SKILL.md ~${savings.skillTokens} + guidance ~${savings.guidanceTokens} - skip block ~${savings.skipBlockTokens})\n`);
    if (metrics.layaOnly.n) {
      stdout.write(`\nLaya-only threshold sweep (${metrics.layaOnly.n} prompts reached the model):\n threshold  precision  recall     F1\n`);
      for (const s of metrics.layaOnly.sweep) {
        stdout.write(`   ${s.threshold.toFixed(2)}     ${pct(s.precision)}   ${pct(s.recall)}  ${pct(s.f1)}\n`);
      }
      stdout.write(`Best F1 threshold: ${metrics.layaOnly.best.threshold.toFixed(2)}\n`);
    }
    const categories = Object.entries(metrics.byCategory);
    if (categories.length) {
      stdout.write(`\nBy category:\n`);
      for (const [name, c] of categories.sort((a, b) => a[0].localeCompare(b[0]))) {
        stdout.write(`  ${name.padEnd(22)} ${String(c.correct).padStart(3)}/${String(c.n).padEnd(3)} ${pct(c.correct / c.n)}${c.wrongSkips ? `  wrong skips ${c.wrongSkips}` : ""}\n`);
      }
    }
    if (args.errors) {
      const wrong = rows.filter((r) => usesMemory(r) !== r.recall);
      stdout.write(`\nMisjudged (${wrong.length}):\n`);
      for (const r of wrong) {
        const s = typeof r.score === "number" ? r.score.toFixed(2) : " -- ";
        stdout.write(`  [${r.recall ? "need" : "none"}] ${r.memoryAction ?? "?"} ${s} ${r.route}${r.boost ? `+${r.boost}` : ""}${r.category ? ` (${r.category})` : ""}  ${r.text.replace(/\s+/gu, " ").slice(0, 90)}\n`);
      }
    }
  }

  if (metrics.routes.fallback > 0 && metrics.routes.laya === 0) {
    const reasons = [...new Set(rows.filter((r) => r.route === "fallback").map((r) => r.reason))].join(", ");
    stdout.write(`\nLaya did not answer (${reasons}). Start it with "npm run laya:start" and retry.\n`);
    return 2;
  }
  return 0;
}

const isEntrypoint = process.argv[1] && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  runEval().then((code) => process.exit(code), (err) => {
    process.stderr.write(`eval-laya failed: ${err.message}\n`);
    process.exit(1);
  });
}
