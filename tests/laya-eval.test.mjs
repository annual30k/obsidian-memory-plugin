import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { computeMetrics, loadDataset, runEval } from "../scripts/eval-laya.mjs";

const fixture = fileURLToPath(new URL("./fixtures/laya-recall-eval.jsonl", import.meta.url));

test("bundled eval dataset is valid and has both labels", () => {
  const rows = loadDataset(fixture);
  assert.ok(rows.length >= 30);
  assert.ok(rows.some((r) => r.recall) && rows.some((r) => !r.recall));
});

test("labelled fixture sets are valid, balanced enough, and carry categories", () => {
  for (const name of ["laya-recall-vault.jsonl", "laya-recall-chat.jsonl"]) {
    const rows = loadDataset(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
    assert.ok(rows.length >= 40, name);
    assert.ok(rows.filter((r) => r.recall).length >= 10 && rows.filter((r) => !r.recall).length >= 10, name);
    assert.ok(rows.every((r) => typeof r.category === "string" && ["recall", "capture", "none"].includes(r.label)), name);
    assert.equal(new Set(rows.map((r) => r.text)).size, rows.length, `${name} has duplicate prompts`);
  }
});

test("computeMetrics breaks accuracy down by category", () => {
  const m = computeMetrics([
    { recall: true, category: "a", route: "laya", recallRecommended: true, score: 0.9 },
    { recall: true, category: "a", route: "laya", recallRecommended: false, score: 0.1, memoryAction: "skip" },
    { recall: false, category: "b", route: "laya", recallRecommended: false, score: 0.1 }
  ], [0.5]);
  assert.deepEqual(m.byCategory, { a: { n: 2, correct: 1, wrongSkips: 1 }, b: { n: 1, correct: 1, wrongSkips: 0 } });
});

test("computeMetrics reports end-to-end and a Laya-only threshold sweep", () => {
  const rows = [
    { recall: true, route: "fast_path", recallRecommended: true, score: 1 },
    { recall: true, route: "laya", recallRecommended: true, score: 0.9 },
    { recall: true, route: "laya", recallRecommended: false, score: 0.5 },
    { recall: false, route: "laya", recallRecommended: false, score: 0.2 },
    { recall: false, route: "laya", recallRecommended: false, score: 0.4 }
  ];
  const m = computeMetrics(rows, [0.3, 0.45, 0.7]);
  assert.deepEqual(m.routes, { fast_path: 1, laya: 4, fallback: 0 });
  assert.equal(m.endToEnd.tp, 2);
  assert.equal(m.endToEnd.fn, 1);
  assert.equal(m.endToEnd.precision, 1);
  assert.equal(m.layaOnly.n, 4);
  assert.equal(m.layaOnly.best.threshold, 0.45);
  assert.equal(m.layaOnly.best.f1, 1);
});

test("runEval exits 2 with a clear message when Laya never answers", async () => {
  let out = "";
  const code = await runEval(["--data", fixture], {
    stdout: { write: (s) => { out += s; } },
    routerFactory: () => ({
      evaluateRecall: async (text) => /之前|上次/.test(text)
        ? { recallRecommended: true, score: 1, reason: "explicit_recall_intent", trace: { route: "fast_path" } }
        : { recallRecommended: false, score: null, reason: "no_trusted_service", trace: { route: "fallback" } },
      dispose() {}
    })
  });
  assert.equal(code, 2);
  assert.match(out, /Laya did not answer \(no_trusted_service\)/);
});

test("label-laya lists unlabelled prompts with suspected misses first and summarizes agreement", async () => {
  const { pendingItems, summarize } = await import("../scripts/label-laya.mjs");
  const decisions = [
    { id: "a", text: "订单模块怎么拆的", action: "skip", host: "codex" },
    { id: "b", text: "写个快排", action: "skip", host: "codex" },
    { id: "c", text: "谢谢", action: "skip", reason: "trivial_greeting" },
    { id: "d", text: "写个快排", action: "skip", host: "codex" },
    { id: "e", text: "之前的结论是什么", action: "recall", reason: "explicit_recall_intent" },
    { type: "suspect", ref: "a", by: "e" }
  ];
  const items = pendingItems(decisions, [{ text: "之前的结论是什么", recall: true, action: "recall" }]);
  assert.deepEqual(items.map((i) => i.text), ["订单模块怎么拆的", "写个快排"]);
  assert.equal(items[0].suspect, true);
  const stats = summarize(decisions, [{ text: "订单模块怎么拆的", recall: true, action: "skip" }, { text: "写个快排", recall: false, action: "skip" }]);
  assert.equal(stats.suspects, 1);
  assert.equal(stats.wrongSkips, 1);
  assert.equal(stats.falseRecalls, 0);
});

test("label-laya review queue lists unreviewed labels, model disagreements then 'needs memory' first", async () => {
  const { reviewQueue } = await import("../scripts/label-laya.mjs");
  const q = reviewQueue([
    { text: "a", recall: false },
    { text: "b", recall: true },
    { text: "c", recall: true, reviewed: true },
    { text: "", recall: true },
    { text: "d", recall: false, suspect: true }
  ]);
  assert.deepEqual(q.map((i) => i.row.text), ["d", "b", "a"]);
  assert.equal(q[1].index, 1);
});

test("four-way labels: context rows are left out, capture counts as using memory", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "laya-labels-")), "d.jsonl");
  fs.writeFileSync(file, [
    { text: "a", label: "recall" }, { text: "b", label: "capture" }, { text: "c", label: "none" },
    { text: "d", label: "context", recall: true }, { text: "e", recall: true }
  ].map((r) => JSON.stringify(r)).join("\n"));
  assert.deepEqual(loadDataset(file).map((r) => [r.text, r.recall]), [["a", true], ["b", true], ["c", false], ["e", true]]);
  fs.writeFileSync(file, JSON.stringify({ text: "a", label: "maybe" }));
  assert.throws(() => loadDataset(file), /recall\/capture\/none\/context/u);
  const { labelOf, ANSWER_LABELS } = await import("../scripts/label-laya.mjs");
  assert.deepEqual(ANSWER_LABELS, { y: "recall", c: "capture", n: "none", x: "context" });
  assert.equal(labelOf({ label: "context", recall: false }), "context");
  assert.equal(labelOf({ recall: true }), "recall");
  assert.equal(labelOf({ label: "bogus" }), null);
});
