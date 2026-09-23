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
