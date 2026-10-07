// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExtractionPrompt, buildMergePrompt, parseExtraction, extractSession, splitSession, maxItemsFor, codexUserModel, resolveExtractor, EXTRACTION_SCHEMA, MAX_EXTRACTED_ITEMS } from "../lib/memory-router/llm-extract.js";
import { codexUserText, parseCodexRollout, candidateEvidence } from "../scripts/replay-digest.mjs";

const item = (over = {}) => ({ kind: "pitfall", scope: "project", title: "t", statement: "Gateway 读的是 .env 而不是 config.yaml", evidence: "实际从 .env 读取", turn: 2, ...over });

test("the extraction prompt carries every turn and marks continuations", () => {
  const prompt = buildExtractionPrompt({ host: "codex", projectId: "P-1", turns: [
    { ts: "t1", prompt: "修一下网关", reply: "根因是 .env" },
    { ts: "t2", prompt: "修一下网关", reply: "继续完成", continued: true }
  ] });
  assert.match(prompt, /project "P-1", 2 turns/u);
  assert.match(prompt, /### Turn 1 \(t1\)\nUser:\n修一下网关/u);
  assert.match(prompt, /### Turn 2[\s\S]*the agent continued the previous request/u);
});

test("the item limit grows with the session's length", () => {
  assert.deepEqual([1, 7, 8, 19, 20, 80].map(maxItemsFor), [3, 3, 4, 4, 5, 5]);
  assert.match(buildExtractionPrompt({ turns: Array.from({ length: 20 }, () => ({ prompt: "p", reply: "r" })) }), /at most 5 items/u);
  assert.equal(EXTRACTION_SCHEMA.properties.items.maxItems, MAX_EXTRACTED_ITEMS);
});

test("a long session is split into parts that keep their turn numbers", () => {
  const turns = Array.from({ length: 40 }, (_, i) => ({ ts: `t${i + 1}`, prompt: `请求 ${i + 1}`, reply: "x".repeat(2900) }));
  const parts = splitSession(turns, 30000);
  assert.ok(parts.length >= 4);
  assert.equal(parts.reduce((n, p) => n + p.blocks.length, 0), 40, "every turn is in exactly one part");
  assert.match(parts[1].blocks[0], new RegExp(`### Turn ${parts[1].first} \\(t${parts[1].first}\\)`, "u"));
  const prompt = buildExtractionPrompt({ turns }, { limit: 3, part: { ...parts[1], index: 2, count: parts.length } });
  assert.match(prompt, new RegExp(`part 2 of ${parts.length}`, "u"));
  assert.doesNotMatch(prompt, /### Turn 1 \(/u);
  // A single oversized turn is a part of its own rather than an endless loop.
  assert.equal(splitSession([{ prompt: "p", reply: "y".repeat(50000) }], 30000).length, 1);
});

test("extractSession makes one call for a short session, parts plus a merge for a long one", async () => {
  const short = { turns: [{ prompt: "p", reply: "r" }] };
  const prompts = [];
  const answer = (items) => async (p) => { prompts.push(p); return JSON.stringify({ items }); };
  assert.equal((await extractSession(short, answer([item({ turn: 1 })]))).calls, 1);

  const long = { turns: Array.from({ length: 40 }, (_, i) => ({ prompt: `p${i}`, reply: "x".repeat(2900) })) };
  prompts.length = 0;
  const out = await extractSession(long, answer([item({ turn: 3 })]));
  assert.equal(out.calls, prompts.length);
  assert.ok(out.calls >= 5);
  assert.match(prompts.at(-1), /Produce the final list for the whole session/u);
  assert.match(prompts.at(-1), /Gateway 读的是 \.env/u, "the merge sees the parts' items");
  // Nothing found in any part: no merge call.
  prompts.length = 0;
  assert.equal((await extractSession(long, answer([]))).calls, prompts.length);
  assert.doesNotMatch(prompts.at(-1), /Produce the final list/u);
});

test("the merge prompt lists every item with its turn", () => {
  const p = buildMergePrompt({ turns: [] }, [item({ turn: 4 }), item({ kind: "decision", title: "只做小程序" })], { limit: 4 });
  assert.match(p, /1\. \[pitfall, project, turn 4\]/u);
  assert.match(p, /2\. \[decision, project, turn 2\] 只做小程序/u);
  assert.match(p, /at most 4 items/u);
});

test("parseExtraction keeps well-formed items and drops the rest", () => {
  const out = parseExtraction(JSON.stringify({ items: [
    item(), item({ kind: "status" }), item({ statement: "  " }),
    item({ statement: "token is sk-ant-api03-" + "a1".repeat(20) }), item({ turn: 99 }), item(), item()
  ] }), { turnCount: 5, limit: 3 });
  assert.equal(out.items.length, 3);
  assert.equal(out.items[1].turn, null, "a turn outside the session is not trusted");
  assert.deepEqual(out.dropped.sort(), ["malformed", "malformed", "over_limit", "sensitive_content"]);
  assert.deepEqual(parseExtraction("```json\n{\"items\":[]}\n```").items, []);
  assert.throws(() => parseExtraction("not json"));
});

test("the output schema is strict enough for structured outputs", () => {
  const props = EXTRACTION_SCHEMA.properties.items.items;
  assert.equal(props.additionalProperties, false);
  assert.deepEqual([...props.required].sort(), Object.keys(props.properties).sort());
});

test("codexUserModel reads only top-level model settings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "om-codex-"));
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "m-1"\nmodel_reasoning_effort = "low"\n[profiles.x]\nmodel = "other"\n');
  assert.deepEqual(codexUserModel(home), { model: "m-1", effort: "low" });
  assert.deepEqual(codexUserModel(path.join(home, "missing")), {});
});

test("replay reads Codex rollouts as user turns", () => {
  assert.equal(codexUserText([{ type: "text", text: "\n# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\n## My request:\n网关列表不能滚动了\n" }, { type: "local_image" }]), "网关列表不能滚动了");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-rollout-"));
  const ev = (type, payload, ts = "2026-09-10T00:00:00Z") => JSON.stringify({ timestamp: ts, type, payload });
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, [
    ev("session_meta", { id: "S1", cwd: "/p", thread_source: "user" }),
    ev("event_msg", { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "修一下" }] } }),
    ev("event_msg", { type: "task_complete", turn_id: "T1", last_agent_message: "根因是 X" }),
    ev("event_msg", { type: "task_complete", turn_id: "T2", last_agent_message: "继续完成" })
  ].join("\n"));
  const parsed = parseCodexRollout(file);
  assert.equal(parsed.id, "S1");
  assert.deepEqual(parsed.turns.map((t) => [t.prompt, t.reply, Boolean(t.continued)]), [["修一下", "根因是 X", false], ["修一下", "继续完成", true]]);
  fs.writeFileSync(file, ev("session_meta", { id: "S2", thread_source: "subagent" }));
  assert.equal(parseCodexRollout(file), null, "subagent threads are not user sessions");
});

test("candidateEvidence returns the evidence section of a rendered candidate", () => {
  const content = "---\ntitle: x\n---\n\n# x\n\n## Candidate evidence\n\n- Request:\n\n> q\n\n## Source reference\n\nabc\n";
  assert.equal(candidateEvidence(content), "- Request:\n\n> q");
  assert.equal(candidateEvidence(content.replace("Candidate evidence", "Original evidence")), "- Request:\n\n> q", "the bundled template's heading");
});

test("resolveExtractor prefers a logged-in Codex, then Hermes, and honours off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-bins-"));
  const codexHome = path.join(dir, "codex-home");
  fs.mkdirSync(codexHome);
  const bin = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 }); return p; };
  const env = { CODEX_BIN: bin("codex"), PATH: "", HOME: dir, HERMES_BIN: bin("hermes") };
  assert.equal(resolveExtractor({ preference: "off", env, codexHome }), null);
  assert.equal(resolveExtractor({ env, codexHome }).name, "hermes", "Codex without a login is skipped");
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "m-1"\n');
  const codex = resolveExtractor({ env, codexHome });
  assert.deepEqual([codex.name, codex.model], ["codex", "m-1"]);
  assert.equal(resolveExtractor({ preference: "hermes", env, codexHome }).name, "hermes");
  assert.equal(resolveExtractor({ preference: "hermes", env: { PATH: "", HOME: dir }, codexHome }), null);
});
