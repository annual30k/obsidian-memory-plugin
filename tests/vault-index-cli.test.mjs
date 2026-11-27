// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexVault, parseArgs } from "../scripts/index-vault.mjs";
import { loadEmbeddingCache, buildVaultIndex, pendingEmbeddings } from "../lib/memory-router/vault-index.js";

function makeVault(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-index-cli-"));
  const wiki = path.join(root, "20-Projects", "demo-12345678", "wiki", "knowledge");
  fs.mkdirSync(wiki, { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(wiki, `n-${i}.md`), `---\ntitle: "笔记 ${i}"\n---\n\n# 笔记 ${i}\n\n第 ${i} 篇的正文。\n`);
  return root;
}

test("laya index embeds every pending note in one run and stops at its time budget", async () => {
  const vault = makeVault(90);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-index-cache-"));
  const indexCachePath = path.join(dir, "idx.json");
  const embeddingCachePath = path.join(dir, "emb.bin");
  let calls = 0;
  const embedPassages = async (texts) => { calls++; return { model: "toy", vectors: texts.map((t, i) => [1, (t.length % 7) / 7, i % 3]) }; };
  const progress = [];
  const r = await indexVault({ vaultPath: vault, model: "toy", embedPassages, indexCachePath, embeddingCachePath, onProgress: (p) => progress.push(p.done) });
  assert.equal(r.notes, 90);
  assert.equal(r.embedded, 90);
  assert.equal(r.pending, 0);
  assert.ok(calls >= 3, "several 32-text batches");
  assert.equal(progress.at(-1), 90);
  const cache = loadEmbeddingCache(embeddingCachePath, { vaultPath: vault, model: "toy" });
  assert.equal(pendingEmbeddings(buildVaultIndex(vault), cache).length, 0);

  // Nothing left: a second run embeds nothing. A spent budget stops before the first batch.
  assert.equal((await indexVault({ vaultPath: vault, model: "toy", embedPassages, indexCachePath, embeddingCachePath })).embedded, 0);
  fs.writeFileSync(path.join(vault, "20-Projects", "demo-12345678", "wiki", "knowledge", "new.md"), "---\ntitle: \"新增的检索笔记\"\n---\n\n# 新增的检索笔记\n\n新增。\n");
  let t = 0;
  const stopped = await indexVault({ vaultPath: vault, model: "toy", embedPassages, indexCachePath, embeddingCachePath, maxMs: 5, now: () => (t += 10) });
  assert.equal(stopped.stopped, "time_budget");
  assert.equal(stopped.pending, 1);
  assert.deepEqual(parseArgs(["--max-minutes", "5", "--vault", "/v"]), { vaultPath: "/v", maxMinutes: 5, help: false });
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
