// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findPython } from "../scripts/python.mjs";
import { validateEmbedResponse, validateRecallResponse, validateHealthResponse, SchemaValidationError } from "../lib/memory-router/schemas.js";
import { LayaClient, LayaHttpError } from "../lib/memory-router/client.js";
import {
  buildVaultIndex, loadEmbeddingCache, pendingEmbeddings, ensureVaultEmbeddings, matchVaultSemantic, noteEmbedText, MIN_SEMANTIC_CANDIDATES, SMALL_SCOPE_CANDIDATES
} from "../lib/memory-router/vault-index.js";
import { enrichDecision } from "../lib/memory-router/turn-context.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { buildLayaActionNotice } from "../lib/prompt.js";
import { modelsForBackend, offlineModelEnv } from "../scripts/laya-service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_PY = path.resolve(__dirname, "..", "lib", "laya-service", "service.py");
const python = findPython();

// ---------------------------------------------------------------- schemas + client

test("validateEmbedResponse accepts unit vectors of one size and rejects anything else", () => {
  const ok = validateEmbedResponse({ model: "m", dim: 3, vectors: [[0.1, 0.2, 0.3], [1, 0, 0]] }, 2);
  assert.equal(ok.dim, 3);
  assert.equal(ok.vectors.length, 2);
  assert.throws(() => validateEmbedResponse({ model: "m", vectors: [[0.1, 0.2], [1]] }), SchemaValidationError);
  assert.throws(() => validateEmbedResponse({ model: "m", vectors: [[0.1, Number.NaN]] }), SchemaValidationError);
  assert.throws(() => validateEmbedResponse({ model: "m", vectors: [[0.1]] }, 2), SchemaValidationError);
  assert.throws(() => validateEmbedResponse({ vectors: [[0.1]] }), SchemaValidationError);
});

test("validateRecallResponse passes a query embedding through only when it is a finite vector with a model name", () => {
  const base = { requires_memory: 0.2, confidence: 0.9 };
  assert.equal(validateRecallResponse(base).queryEmbedding, undefined);
  assert.deepEqual(validateRecallResponse({ ...base, query_embedding: [0.6, 0.8], embed_model: "e5" }).queryEmbedding, [0.6, 0.8]);
  assert.equal(validateRecallResponse({ ...base, query_embedding: [0.6, "x"], embed_model: "e5" }).queryEmbedding, undefined);
  assert.equal(validateRecallResponse({ ...base, query_embedding: [0.6, 0.8] }).queryEmbedding, undefined, "no model name: vector is dropped");
});

test("LayaClient.embed posts texts with a kind and validates the reply; judgeRecall forwards the embed flag", async () => {
  const seen = [];
  const mockFetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith("/embed")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ model: "mock-embed", dim: 2, vectors: [[1, 0], [0, 1]] }) };
    }
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: 0.1, confidence: 0.9, query_embedding: [0.6, 0.8], embed_model: "mock-embed" }) };
  };
  const client = new LayaClient("http://127.0.0.1:18791", { fetch: mockFetch });
  const out = await client.embed({ texts: ["a note", "another"], kind: "passage" });
  assert.equal(out.model, "mock-embed");
  assert.deepEqual(seen[0].body, { texts: ["a note", "another"], kind: "passage" });
  const recall = await client.judgeRecall({ text: "hello there", embed: true });
  assert.equal(seen[1].body.embed, true);
  assert.deepEqual(recall.queryEmbedding, [0.6, 0.8]);
  await assert.rejects(client.embed({ texts: [] }), LayaHttpError);
  await assert.rejects(client.embed({ texts: ["x"], kind: "other" }), LayaHttpError);
  await assert.rejects(client.embed({ texts: Array.from({ length: 33 }, () => "x") }), LayaHttpError);
});

// ---------------------------------------------------------------- vault index + semantic match

function note(dir, name, title, body = "Body text.") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `---\ntitle: "${title}"\ntype: pitfall\n---\n\n# ${title}\n\n${body}\n`);
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-sem-vault-"));
  fs.mkdirSync(path.join(root, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(root, "00-System", "projects.yaml"), "projects:\n  - id: plugin-1f6a88a6\n    roots:\n      - /work/plugin\n");
  const wiki = path.join(root, "20-Projects", "plugin-1f6a88a6", "wiki");
  note(path.join(wiki, "pitfalls"), "symlink.md", "Installer breaks on dangling symlinks", "existsSync returns false for a dangling symlink; use lstatSync before linking.");
  note(path.join(wiki, "decisions"), "release.md", "Release process for the plugin", "Bump the version, pack, sign SHA256SUMS, upload.");
  note(path.join(wiki, "knowledge"), "vault-health.md", "Vault health inspection contract", "Checkpoints count as valid link targets.");
  note(path.join(wiki, "decisions"), "hosts.md", "Multi-host adaptation boundaries", "Managed blocks carry data, not instructions.");
  note(path.join(wiki, "pitfalls"), "ordering.md", "Chat ordering on Android", "Timeline order follows the server timestamp.");
  note(path.join(root, "10-Global", "inbox"), "prefs.md", "Reply language preference", "Reply in Chinese.");
  return root;
}

// A toy "model": unit vectors over a handful of topics, so tests control the geometry exactly.
const TOPICS = ["symlink", "release", "health", "hosts", "ordering", "language"];
const unit = (weights) => {
  const v = TOPICS.map((t) => weights[t] ?? 0);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
};
const toyEmbed = (text) => {
  const lower = text.toLowerCase();
  const weights = {};
  for (const t of TOPICS) weights[t] = lower.includes(t) ? 1 : 0.05;
  return unit(weights);
};

test("noteEmbedText carries the topic line plus the start of the body", () => {
  const text = noteEmbedText("/v/wiki/symlink.md", "---\ntitle: \"Dangling symlinks\"\n---\n\n# Dangling symlinks\n\nUse   lstatSync.\n");
  assert.match(text, /Dangling symlinks/u);
  assert.match(text, /Use lstatSync\./u);
});

test("ensureVaultEmbeddings embeds only new or changed notes, in bounded batches, and prunes removed ones", async () => {
  const vault = makeVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-sem-cache-"));
  const cachePath = path.join(dir, "vault-embeddings.json");
  const index = buildVaultIndex(vault);
  assert.equal(index.n, 6);
  assert.ok(index.notes.every((n) => typeof n.hash === "string" && n.embedText));
  const cache = loadEmbeddingCache(cachePath, { vaultPath: vault, model: "toy" });
  assert.equal(pendingEmbeddings(index, cache).length, 6);

  const calls = [];
  const embedFn = async (texts) => { calls.push(texts.length); return texts.map(toyEmbed); };
  let r = await ensureVaultEmbeddings(index, cache, embedFn, { cachePath, maxNotes: 4 });
  assert.deepEqual([r.embedded, r.pending], [4, 2]);
  r = await ensureVaultEmbeddings(index, cache, embedFn, { cachePath, maxNotes: 4 });
  assert.deepEqual([r.embedded, r.pending], [2, 0]);
  r = await ensureVaultEmbeddings(index, cache, embedFn, { cachePath, maxNotes: 4 });
  assert.deepEqual([r.embedded, r.pending], [0, 0]);
  assert.deepEqual(calls, [4, 2]);

  // Persisted and reloaded for the same Vault + model; a different model starts empty.
  const reloaded = loadEmbeddingCache(cachePath, { vaultPath: vault, model: "toy" });
  assert.equal(Object.keys(reloaded.entries).length, 6);
  assert.equal(Object.keys(loadEmbeddingCache(cachePath, { vaultPath: vault, model: "other" }).entries).length, 0);

  // Editing a note invalidates only that note; deleting one prunes its entry.
  fs.writeFileSync(path.join(vault, "20-Projects", "plugin-1f6a88a6", "wiki", "pitfalls", "symlink.md"), "---\ntitle: \"Symlink note rewritten\"\n---\n\n# Symlink note rewritten\n\nNew body.\n");
  fs.rmSync(path.join(vault, "10-Global", "inbox", "prefs.md"));
  const index2 = buildVaultIndex(vault);
  assert.equal(pendingEmbeddings(index2, reloaded).length, 1);
  r = await ensureVaultEmbeddings(index2, reloaded, embedFn, { cachePath, maxNotes: 32 });
  assert.equal(r.embedded, 1);
  assert.equal(Object.keys(reloaded.entries).length, 5);
});

test("matchVaultSemantic ranks by prominence over the candidate notes, not by absolute cosine", async () => {
  const vault = makeVault();
  const index = buildVaultIndex(vault);
  const cache = loadEmbeddingCache(path.join(os.tmpdir(), "unused.json"), { vaultPath: vault, model: "toy" });
  await ensureVaultEmbeddings(index, cache, async (texts) => texts.map(toyEmbed), {});

  const strong = matchVaultSemantic(index, cache, toyEmbed("the installer fails on a symlink"), { projectId: "plugin-1f6a88a6" });
  assert.equal(strong.strength, "strong");
  assert.equal(strong.candidates, 6);
  assert.match(strong.hits[0].path, /symlink\.md$/u);

  // Equally similar to every note: nothing stands out.
  const flat = matchVaultSemantic(index, cache, unit({ symlink: 1, release: 1, health: 1, hosts: 1, ordering: 1, language: 1 }), { projectId: "plugin-1f6a88a6" });
  assert.equal(flat.strength, "none");
  assert.deepEqual(flat.hits, []);

  // Too few embedded candidates: no verdict (the word-overlap hints take over).
  const small = { ...cache, entries: Object.fromEntries(Object.entries(cache.entries).slice(0, MIN_SEMANTIC_CANDIDATES - 1)) };
  assert.equal(matchVaultSemantic(index, small, toyEmbed("symlink"), {}).strength, "none");
  assert.ok(matchVaultSemantic(index, small, toyEmbed("symlink"), {}).candidates < MIN_SEMANTIC_CANDIDATES);

  // A stale vector (note edited since) is not used.
  const stale = { ...cache, entries: { ...cache.entries } };
  const key = Object.keys(stale.entries).find((k) => k.endsWith("symlink.md"));
  stale.entries[key] = { ...stale.entries[key], hash: "old" };
  assert.doesNotMatch(matchVaultSemantic(index, stale, toyEmbed("symlink"), {}).hits[0]?.path ?? "", /symlink\.md$/u);
});

test("matchVaultSemantic: a resolved project never sees other projects' notes, and a small scope is judged against the whole Vault", async () => {
  const vault = makeVault();
  // A big second project whose notes are all about symlinks.
  for (let i = 0; i < SMALL_SCOPE_CANDIDATES + 5; i++) {
    note(path.join(vault, "20-Projects", "other-0000aaaa", "wiki", "pitfalls"), `s${i}.md`, `Symlink case ${i}`, "symlink symlink");
  }
  const index = buildVaultIndex(vault);
  const cache = loadEmbeddingCache(path.join(os.tmpdir(), "unused2.json"), { vaultPath: vault, model: "toy" });
  await ensureVaultEmbeddings(index, cache, async (texts) => texts.map(toyEmbed), { maxNotes: 100 });

  // A project with no notes yet: only Global is a candidate (it used to fall back to the whole Vault).
  const empty = matchVaultSemantic(index, cache, toyEmbed("symlink"), { projectId: "brand-new-00000000" });
  assert.ok(empty.hits.every((h) => h.projectId === "global"));
  assert.equal(empty.candidates, 1);

  // plugin-1f6a88a6 has 6 candidates. Its one symlink note stands out within the scope, but symlinks are
  // what the Vault is mostly about, so against the whole Vault nothing stands out.
  const small = matchVaultSemantic(index, cache, toyEmbed("symlink"), { projectId: "plugin-1f6a88a6" });
  assert.equal(small.candidates, 6);
  assert.equal(small.strength, "none");
  // A topic that is rare in the Vault still stands out in the small scope.
  const rare = matchVaultSemantic(index, cache, toyEmbed("release"), { projectId: "plugin-1f6a88a6" });
  assert.equal(rare.strength, "strong");
  assert.match(rare.hits[0].path, /release\.md$/u);
});

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-sem-turn-"));
  return {
    now: 1_000_000,
    env: {},
    indexCachePath: path.join(dir, "vault-index.json"),
    sessionStatePath: path.join(dir, "session-state.json"),
    decisionLogPath: path.join(dir, "decisions.jsonl")
  };
}

const layaDecision = (score, action, vec) => ({
  recallRecommended: action === "recall", captureRecommended: false, score, reason: "laya_below_threshold",
  blocked: false, memoryAction: action, trace: { route: "laya", decision: "none" },
  ...(vec ? { queryEmbedding: vec, embedModel: "toy" } : {})
});

async function semanticSetup() {
  const vault = makeVault();
  const index = buildVaultIndex(vault);
  const cache = loadEmbeddingCache(path.join(os.tmpdir(), "unused.json"), { vaultPath: vault, model: "toy" });
  await ensureVaultEmbeddings(index, cache, async (texts) => texts.map(toyEmbed), {});
  return { vault, index, cache };
}

test("a strong semantic match turns a model skip into recall with the note paths; a weak one only blocks the skip", async () => {
  const { vault, index, cache } = await semanticSetup();
  const turn = { host: "codex", vaultPath: vault, cwd: "/work/plugin" };
  const options = { ...ctx(), vaultIndex: index, embeddingCache: cache };

  const d = enrichDecision(layaDecision(0.1, "skip", toyEmbed("installer symlink problem")), "the installer fails on a symlink", turn, {}, options);
  assert.equal(d.memoryAction, "recall");
  assert.equal(d.boost, "vault_match_strong");
  assert.equal(d.vault.mode, "semantic");
  assert.match(d.relatedNotes[0], /symlink\.md$/u);
  assert.match(buildLayaActionNotice(d), /look up memory first/u);
  assert.match(buildLayaActionNotice(d), /symlink\.md/u);

  // Weak: one note stands out a little, not decisively. Find such a vector with the matcher itself.
  let weakVec = null;
  for (let w = 0.5; w <= 0.7 && !weakVec; w += 0.002) {
    const candidate = unit({ symlink: w, release: 0.5, health: 0.5, hosts: 0.5, ordering: 0.5, language: 0.5 });
    if (matchVaultSemantic(index, cache, candidate, { projectId: "plugin-1f6a88a6" }).strength === "weak") weakVec = candidate;
  }
  assert.ok(weakVec, "a weak match must exist between none and strong");
  const w = enrichDecision(layaDecision(0.1, "skip", weakVec), "something about the installer", turn, {}, options);
  assert.equal(w.vault.mode, "semantic");
  assert.equal(w.vault.strength, "weak");
  assert.equal(w.memoryAction, "default");
  assert.equal(w.boost, "vault_match_weak");
  assert.match(w.relatedNotes[0], /symlink\.md$/u);

  // Nothing stands out: the model's skip stands.
  const flat = enrichDecision(layaDecision(0.1, "skip", unit({ symlink: 1, release: 1, health: 1, hosts: 1, ordering: 1, language: 1 })), "some unrelated request", turn, {}, options);
  assert.equal(flat.memoryAction, "skip");
  assert.equal(flat.vault.strength, "none");
});

test("without a query vector or with a model mismatch the word-overlap hints run instead", async () => {
  const { vault, index, cache } = await semanticSetup();
  const turn = { host: "codex", vaultPath: vault, cwd: "/work/plugin" };
  const d = enrichDecision(layaDecision(0.4, "default"), "unrelated wording here", turn, {}, { ...ctx(), vaultIndex: index, embeddingCache: cache });
  assert.equal(d.vault.mode, "words");
  const mismatch = { ...layaDecision(0.4, "default", toyEmbed("symlink")), embedModel: "another-model" };
  const m = enrichDecision(mismatch, "unrelated wording here", turn, {}, { ...ctx(), vaultIndex: index, embeddingCache: cache });
  assert.equal(m.vault.mode, "words");
  const off = enrichDecision(layaDecision(0.4, "default", toyEmbed("symlink")), "unrelated wording here", turn, { vaultSemantic: false }, { ...ctx(), vaultIndex: index, embeddingCache: cache });
  assert.equal(off.vault.mode, "words");
});

// ---------------------------------------------------------------- router end to end (mock fetch)

test("MemoryRouter asks for the prompt vector when the service can embed, indexes the Vault through /embed, and never leaks the vector", async () => {
  const vault = makeVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-sem-router-"));
  const embedCalls = [];
  const mockFetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: "ready", capabilities: ["recall", "embed"] }) };
    }
    const body = JSON.parse(options.body);
    if (u.endsWith("/embed")) {
      embedCalls.push(body.texts.length);
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ model: "toy", dim: TOPICS.length, vectors: body.texts.map(toyEmbed) }) };
    }
    if (u.endsWith("/judge/recall")) {
      assert.equal(body.embed, true);
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: 0.05, confidence: 0.9, query_embedding: toyEmbed(body.text), embed_model: "toy" }) };
    }
    return { ok: false, status: 404, headers: new Map(), text: async () => "" };
  };
  const router = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, {
    fetch: mockFetch,
    env: {},
    vaultIndexCachePath: path.join(dir, "vault-index.json"),
    embeddingCachePath: path.join(dir, "vault-embeddings.json"),
    sessionStatePath: path.join(dir, "session-state.json"),
    decisionLogPath: path.join(dir, "decisions.jsonl"),
    embedBatchSize: 4
  });
  try {
    const turn = { host: "codex", vaultPath: vault, cwd: "/work/plugin" };
    const first = await router.evaluateRecall("the installer fails on a symlink", null, turn);
    assert.equal(first.queryEmbedding, undefined, "vector must not leave the router");
    assert.deepEqual(embedCalls, [4], "one bounded batch per turn");
    // Four of six notes embedded: below the candidate minimum, so this turn used word hints.
    assert.equal(first.vault.mode, "words");

    const second = await router.evaluateRecall("the installer fails on a symlink", null, turn);
    assert.deepEqual(embedCalls, [4, 2]);
    assert.equal(second.vault.mode, "semantic");
    assert.equal(second.memoryAction, "recall");
    assert.equal(second.boost, "vault_match_strong");
    assert.match(second.relatedNotes[0], /symlink\.md$/u);

    const third = await router.evaluateRecall("write a haiku about autumn", null, turn);
    assert.deepEqual(embedCalls, [4, 2], "a covered Vault costs no embed call");
    assert.equal(third.memoryAction, "skip");
    const log = fs.readFileSync(path.join(dir, "decisions.jsonl"), "utf8");
    assert.match(log, /"vaultMode":"semantic"/u);
    assert.doesNotMatch(log, /queryEmbedding/u);
  } finally {
    router.dispose();
  }
});

test("modelsForBackend lists the retriever on MLX only and offlineModelEnv needs every model cached", () => {
  assert.deepEqual(modelsForBackend("mlx"), ["aac6fef/laya-multilingual-mlx", "intfloat/multilingual-e5-small"]);
  assert.deepEqual(modelsForBackend("mlx", { embedModel: "off" }), ["aac6fef/laya-multilingual-mlx"]);
  assert.deepEqual(modelsForBackend("pytorch"), ["convaiinnovations/laya-multilingual"]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "laya-hf2-"));
  try {
    fs.mkdirSync(path.join(home, ".cache", "huggingface", "hub", "models--org--a", "snapshots", "x"), { recursive: true });
    assert.deepEqual(offlineModelEnv({}, ["org/a", "org/b"], home), {}, "the retriever is not cached yet: keep the network");
    fs.mkdirSync(path.join(home, ".cache", "huggingface", "hub", "models--org--b", "snapshots", "x"), { recursive: true });
    assert.deepEqual(offlineModelEnv({}, ["org/a", "org/b"], home), { HF_HUB_OFFLINE: "1" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- python service (mock backend)

test("service.py mock backend serves /embed, adds the query vector to /judge/recall on request, and bounds the input", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-embed-test-"));
  const serviceFile = path.join(tmpDir, "service.json");
  const token = "test-secret-token-1234567890";
  const pyProc = spawn(python.command, [...python.args, SERVICE_PY, "--backend", "mock", "--service-file", serviceFile, "--token", token, "--port", "0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderrData = "";
  pyProc.stderr.on("data", (d) => { stderrData += d.toString(); });
  try {
    const start = Date.now();
    while (Date.now() - start < 10000 && !fs.existsSync(serviceFile)) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(serviceFile), `service.json must exist. stderr: ${stderrData}`);
    const endpoint = JSON.parse(fs.readFileSync(serviceFile, "utf8")).endpoint;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const health = validateHealthResponse(await (await fetch(`${endpoint}/health`, { headers })).json());
    assert.ok(health.capabilities.includes("embed"));

    const unauth = await fetch(`${endpoint}/embed`, { method: "POST", body: JSON.stringify({ texts: ["a"] }), headers: { "Content-Type": "application/json" } });
    assert.equal(unauth.status, 401);

    const res = await fetch(`${endpoint}/embed`, { method: "POST", headers, body: JSON.stringify({ texts: ["installer symlink EEXIST", "symlink EEXIST in the installer", "weather tomorrow"], kind: "passage" }) });
    assert.equal(res.status, 200);
    const out = validateEmbedResponse(await res.json(), 3);
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
    assert.ok(dot(out.vectors[0], out.vectors[1]) > dot(out.vectors[0], out.vectors[2]), "shared wording must score higher in the mock");
    assert.ok(Math.abs(dot(out.vectors[0], out.vectors[0]) - 1) < 0.01, "vectors are unit length");

    const bad = await fetch(`${endpoint}/embed`, { method: "POST", headers, body: JSON.stringify({ texts: Array.from({ length: 33 }, () => "x") }) });
    assert.equal(bad.status, 400);
    const badKind = await fetch(`${endpoint}/embed`, { method: "POST", headers, body: JSON.stringify({ texts: ["x"], kind: "nope" }) });
    assert.equal(badKind.status, 400);

    const plain = await (await fetch(`${endpoint}/judge/recall`, { method: "POST", headers, body: JSON.stringify({ text: "回忆一下软链接的坑" }) })).json();
    assert.equal(plain.query_embedding, undefined);
    const withVec = validateRecallResponse(await (await fetch(`${endpoint}/judge/recall`, { method: "POST", headers, body: JSON.stringify({ text: "回忆一下软链接的坑", embed: true }) })).json());
    assert.equal(withVec.embedModel, "mock-embed");
    assert.equal(withVec.queryEmbedding.length, out.dim);
  } finally {
    pyProc.kill("SIGTERM");
    await new Promise((r) => pyProc.once("exit", r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("a one-shot hook process that restores health from the cache still asks for the prompt vector", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-sem-cache-"));
  const cachePath = path.join(dir, "state.json");
  const seen = { health: 0, embedFlags: [] };
  const mockFetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      seen.health++;
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: "ready", capabilities: ["recall", "embed", "warmup"] }) };
    }
    const body = JSON.parse(options.body);
    seen.embedFlags.push(body.embed === true);
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: 0.1, confidence: 0.9 }) };
  };
  const make = () => new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { fetch: mockFetch, env: {}, useCache: true, cachePath });
  const first = make();
  await first.evaluateRecall("第一个钩子进程");
  first.dispose();
  const persisted = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const entry = Object.values(persisted.endpoints)[0];
  assert.deepEqual(entry.health.capabilities, ["recall", "embed", "warmup"], "capabilities are persisted");

  const second = make();
  await second.evaluateRecall("第二个钩子进程");
  second.dispose();
  assert.equal(seen.health, 1, "the second process trusts the cached handshake");
  assert.deepEqual(seen.embedFlags, [true, true], "both processes ask for the prompt vector");

  // A cache written by an older version (no capabilities) still asks; a service known not to embed does not.
  const legacy = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  for (const e of Object.values(legacy.endpoints)) delete e.health.capabilities;
  fs.writeFileSync(cachePath, JSON.stringify(legacy));
  const third = make();
  await third.evaluateRecall("旧缓存");
  third.dispose();
  assert.equal(seen.embedFlags.at(-1), true);
  const known = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { fetch: mockFetch, env: {} });
  known.healthInfo = { capabilities: ["recall"] };
  assert.equal(known._supportsEmbed(), false);
  known.dispose();
});
