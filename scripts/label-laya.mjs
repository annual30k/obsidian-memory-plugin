#!/usr/bin/env node
/**
 * Label real prompts from the local decision log so the router can be evaluated on YOUR usage.
 *
 *   npm run laya:label              # interactive: y = look up memory first, c = asks to save something,
 *                                   #   n = the prompt/code/conversation is enough, x = can't tell from this prompt alone,
 *                                   #   s = skip, q = quit
 *   npm run laya:label -- --stats   # summary only
 *   npm run laya:label -- --review  # check the labels in ~/.laya/labels-bootstrap.jsonl (Enter keeps a label)
 *   npm run laya:eval -- --data ~/.laya/labels.jsonl
 *
 * Reads ~/.laya/decisions.jsonl (written by the host hooks; local only, mode 0600) and appends
 * answers to ~/.laya/labels.jsonl. Suspected misses (the user asked about the past right after a
 * skipped turn) are shown first. Set OBSIDIAN_MEMORY_DECISION_LOG=off to stop logging.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultServiceFilePath } from "../lib/config.js";

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/u).filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/** Unlabelled decisions with text, suspected misses first, then newest first, one per distinct text. */
export function pendingItems(decisions, labels) {
  const labelled = new Set(labels.map((l) => l.text));
  const suspects = new Set(decisions.filter((d) => d.type === "suspect").map((d) => d.ref));
  const seen = new Set();
  const items = [];
  for (const d of [...decisions].reverse()) {
    if (d.type || typeof d.text !== "string" || !d.text.trim() || labelled.has(d.text) || seen.has(d.text)) continue;
    if (d.reason === "trivial_greeting" || d.reason === "empty_text") continue;
    seen.add(d.text);
    items.push({ ...d, suspect: suspects.has(d.id) });
  }
  return items.sort((a, b) => Number(b.suspect) - Number(a.suspect));
}

export function summarize(decisions, labels) {
  const turns = decisions.filter((d) => !d.type);
  const by = (key) => turns.reduce((acc, d) => { const k = d[key] ?? "none"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const agreed = labels.filter((l) => typeof l.action === "string" && l.label !== "context").map((l) => ({
    needed: l.recall, routed: l.action === "recall" || l.action === "capture", skipped: l.action === "skip"
  }));
  return {
    turns: turns.length,
    actions: by("action"),
    boosts: by("boost"),
    hosts: by("host"),
    suspects: decisions.filter((d) => d.type === "suspect").length,
    labelled: labels.length,
    labelledNeeded: labels.filter((l) => l.recall).length,
    missedRecalls: agreed.filter((a) => a.needed && !a.routed).length,
    wrongSkips: agreed.filter((a) => a.needed && a.skipped).length,
    falseRecalls: agreed.filter((a) => !a.needed && a.routed).length
  };
}

function parseArgs(argv) {
  const dir = path.dirname(defaultServiceFilePath());
  const args = { log: path.join(dir, "decisions.jsonl"), labels: path.join(dir, "labels.jsonl"), stats: false, review: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log" && argv[i + 1]) args.log = path.resolve(argv[++i]);
    else if (argv[i] === "--labels" && argv[i + 1]) args.labels = path.resolve(argv[++i]);
    else if (argv[i] === "--stats") args.stats = true;
    else if (argv[i] === "--review") args.review = argv[i + 1] && !argv[i + 1].startsWith("--") ? path.resolve(argv[++i]) : path.join(dir, "labels-bootstrap.jsonl");
  }
  return args;
}

// y/c/n/x -> label. "recall" needs a look-up in long-term memory (past decisions, conventions, preferences,
// recorded facts); depending on the current conversation, the code or git history does not count.
export const ANSWER_LABELS = Object.freeze({ y: "recall", c: "capture", n: "none", x: "context" });
const LABEL_TEXT = { recall: "y = look up memory", capture: "c = save to memory", none: "n = no memory needed", context: "x = can't tell alone" };
const HELP = "y = look up memory first, c = asks to save something, n = prompt/code/conversation is enough, x = can't tell from this prompt alone";

export function labelOf(row) {
  if (Object.values(ANSWER_LABELS).includes(row.label)) return row.label;
  return typeof row.recall === "boolean" ? (row.recall ? "recall" : "none") : null;
}

/**
 * Unreviewed rows of a labels file, most likely mistakes first: rows where the model's out-of-fold score
 * disagrees with the label (`suspect`), then rows marked as needing memory (few, and they matter most).
 */
export function reviewQueue(rows) {
  const rank = (row) => (row.suspect ? 2 : 0) + (labelOf(row) !== "none" ? 1 : 0);
  return rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => typeof row.text === "string" && row.text.trim() && labelOf(row) && !row.reviewed)
    .sort((a, b) => rank(b.row) - rank(a.row));
}

function writeJsonlAtomic(file, rows) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Check labels someone else (or a model) wrote: Enter keeps the label, y/c/n/x sets it, s skips, q quits. */
async function review(file) {
  const rows = readJsonl(file);
  const queue = reviewQueue(rows);
  const reviewed = rows.filter((r) => r.reviewed).length;
  const focus = queue.filter(({ row }) => row.suspect || labelOf(row) !== "none").length;
  console.log(`${file}: ${rows.length} labels, ${reviewed} already reviewed, ${queue.length} to go.`);
  console.log(`The first ${focus} matter most (⚠ = the model disagrees with the label, then the ones not labelled "n"); after those you can press q.`);
  if (queue.length === 0) return;
  console.log(`Enter = the label is right; ${HELP}; s = skip, q = quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let done = 0;
  try {
    for (const { row, index } of queue) {
      const model = typeof row.modelScore === "number" ? `  model=${row.modelScore.toFixed(2)}${row.suspect ? " ⚠ disagrees" : ""}` : "";
      const current = labelOf(row);
      console.log(`\n[${done + reviewed + 1}/${rows.length}  current label: ${LABEL_TEXT[current]}${model}${row.kind ? `  kind=${row.kind}` : ""}]\n${row.text}`);
      const answer = (await rl.question("Label? (Enter/y/c/n/x/s/q) ")).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "s" || (answer && !ANSWER_LABELS[answer])) continue;
      const label = answer ? ANSWER_LABELS[answer] : current;
      rows[index] = { ...row, label, recall: label === "recall" || label === "capture", reviewed: true, ...(label !== current ? { corrected: true } : {}) };
      writeJsonlAtomic(file, rows);
      done++;
    }
  } finally {
    rl.close();
  }
  const corrected = rows.filter((r) => r.corrected).length;
  console.log(`\nReviewed ${done} this time (${corrected} corrected in total). Retrain with: npm run laya:train && laya stop && laya start`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.review) {
    if (!fs.existsSync(args.review)) {
      console.log(`Nothing to review: ${args.review} not found.`);
      return;
    }
    await review(args.review);
    return;
  }
  const decisions = [...readJsonl(`${args.log}.1`), ...readJsonl(args.log)];
  const labels = readJsonl(args.labels);
  const stats = summarize(decisions, labels);
  console.log(`Logged turns: ${stats.turns}  actions ${JSON.stringify(stats.actions)}  boosts ${JSON.stringify(stats.boosts)}`);
  console.log(`Suspected misses: ${stats.suspects}  Labelled: ${stats.labelled} (${stats.labelledNeeded} needed memory)`);
  if (stats.labelled) {
    console.log(`On labelled prompts: missed recalls ${stats.missedRecalls}, wrongly skipped ${stats.wrongSkips}, unnecessary recalls ${stats.falseRecalls}`);
  }
  if (args.stats) return;

  const items = pendingItems(decisions, labels);
  if (items.length === 0) {
    console.log("Nothing new to label.");
    return;
  }
  console.log(`\n${items.length} prompts to label. ${HELP}; s = skip, q = quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let done = 0;
  try {
    for (const item of items) {
      const meta = [item.host, `action=${item.action}`, item.score !== null ? `score=${item.score}` : null, item.boost ? `boost=${item.boost}` : null, item.suspect ? "SUSPECTED MISS" : null].filter(Boolean).join("  ");
      console.log(`\n[${meta}]\n${item.text}`);
      const answer = (await rl.question("Label? (y/c/n/x/s/q) ")).trim().toLowerCase();
      if (answer === "q") break;
      const label = ANSWER_LABELS[answer];
      if (!label) continue;
      fs.mkdirSync(path.dirname(args.labels), { recursive: true, mode: 0o700 });
      fs.appendFileSync(args.labels, JSON.stringify({ text: item.text, label, recall: label === "recall" || label === "capture", action: item.action, score: item.score, ts: new Date().toISOString() }) + "\n", { mode: 0o600 });
      done++;
    }
  } finally {
    rl.close();
  }
  console.log(`\nSaved ${done} labels to ${args.labels}. Evaluate with: npm run laya:eval -- --data ${args.labels}`);
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  main().catch((err) => { console.error(`label-laya failed: ${err.message}`); process.exit(1); });
}
