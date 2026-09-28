// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
// Regression tests for the gaps found in the 2026-09-27 audit and closed afterwards: queue claims, the
// explicit-request backstop, held findings for sessions without a project, Antigravity's final turn,
// Hermes through the session state, one set of environment settings, bounded Vault backfill, explicit
// recall with the retriever, fair index slots, retention stats and the doctor checks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { enqueueCapture, listQueue, claimSession, readSessionRecords, sessionIdFor } from "../lib/memory-router/capture-queue.js";
import { runDigest, findingScope, listHeld, fileHeld, discardHeld, holdFinding, digestStats, takeStagedSinceNotice, nextDigestDelay } from "../lib/memory-router/digest.js";
import { enrichDecision, enqueueTurnEnd, pendingCaptureEnforcement, inboxBaseline, inboxWrittenSince } from "../lib/memory-router/turn-context.js";
import { registerTranscript, listTranscripts, antigravityLastExchange, nextTranscriptDelay } from "../lib/memory-router/transcripts.js";
import { collectIdleTranscripts } from "../scripts/memory-digest.mjs";
import { runCli } from "../lib/memory-router/cli.js";
import { memoryJudgeFromEnv, memoryJudgeModeFromEnv, defaultServiceFilePath } from "../lib/config.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { allocateIndexSlots } from "../lib/memory-router/vault-index.js";
import { buildLayaActionNotice } from "../lib/prompt.js";
import { collect } from "../scripts/doctor.mjs";

const PID = "demo-app-12345678";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const REPLY = (n = 1) => `已修复 setup.mjs（第 ${n} 轮）。\n\n原因：existsSync 会跟随软链接，失效链接返回 false，导致跳过删除；链接本身仍占用目标路径，因此创建时报 EEXIST。\n\n修法：去掉存在性判断，直接调用带 force: true 的 rmSync，它删除链接本身而不跟随目标。已用失效链接、正常文件和空路径三种情况验证，行为都符合预期，其他文件没有改动。以后处理链接替换时统一先 lstat 再删除。`;
const old = (file, ms = 3600_000) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };

function setup() {
  const root = tmp("om-gap-vault-");
  const project = tmp("om-gap-proj-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Vault\n");
  fs.mkdirSync(path.join(root, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(root, "00-System", "projects.yaml"), `projects:\n  - id: ${PID}\n    roots:\n      - ${project}\n    scope: private\n`);
  fs.mkdirSync(path.join(root, "10-Global", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(root, "20-Projects", PID, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(root, "20-Projects", PID, "AGENTS.md"), "# demo\n");
  const state = tmp("om-gap-state-");
  return { root, project, stateDir: state, queueDir: path.join(state, "queue"), sessionStatePath: path.join(state, "session-state.json") };
}
const inboxOf = (v, scope = "project") => {
  const dir = scope === "global" ? path.join(v.root, "10-Global", "inbox") : path.join(v.root, "20-Projects", PID, "inbox");
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
};
const explicitDecision = () => ({ memoryAction: "capture", captureRecommended: true, captureKind: "explicit", reason: "explicit_remember_intent", trace: { route: "fast_path" } });
const plainDecision = () => ({ memoryAction: "skip", score: 0.05, reason: "laya_below_threshold", trace: { route: "laya" } });

// ---------------------------------------------------------------- queue claims (no lost turns)

test("a turn that ends while the digest runs is not deleted with the claimed queue", async () => {
  const v = setup();
  const t = { host: "codex", sessionKey: "race", vaultPath: v.root, cwd: v.project };
  // Few conclusion words, so the digest asks for a score: that is where the late turn arrives.
  const weak = "这一轮把页面的按钮颜色和间距都调整了一遍，顺便整理了样式文件的结构，看起来比之前清爽一些。".repeat(6);
  enqueueCapture("turn", { prompt: "调一下样式", reply: weak }, t, { queueDir: v.queueDir });
  old(listQueue(v.queueDir)[0].file);
  let arrived = false;
  const res = await runDigest({
    queueDir: v.queueDir, stateDir: v.stateDir,
    score: async () => {
      if (!arrived) { enqueueCapture("turn", { prompt: "再修一下", reply: REPLY(2) }, t, { queueDir: v.queueDir }); arrived = true; }
      return 0.1;
    }
  });
  assert.equal(arrived, true);
  assert.equal(res.processed, 1);
  const left = listQueue(v.queueDir);
  assert.equal(left.length, 1, "the late turn is still queued");
  assert.equal(left[0].segments.length, 0, "the processed segment is gone");
  assert.match(readSessionRecords(left[0].files)[0].reply, /第 2 轮/u);

  // Claiming directly: the live file is renamed away and later appends start a new one.
  const entry = listQueue(v.queueDir)[0];
  const claimed = claimSession(entry);
  assert.equal(fs.existsSync(entry.file), false);
  assert.equal(readSessionRecords(claimed).length, 1);
});

// ---------------------------------------------------------------- staged detection + explicit backstop

test("staged detection compares file times with file times, counts in-place updates and ignores the digest's files", () => {
  const dir = tmp("om-gap-inbox-");
  const a = path.join(dir, "cand-a.md");
  fs.writeFileSync(a, "---\nstatus: pending-ingest\n---\n");
  old(a, 60_000);
  const base = inboxBaseline([dir]);
  assert.equal(inboxWrittenSince([dir], base), false);
  fs.writeFileSync(path.join(dir, "cand-auto.md"), "---\norigin: \"auto-digest\"\n---\n");
  assert.equal(inboxWrittenSince([dir], base), false, "the digest's own candidate is not the agent's");
  fs.appendFileSync(a, "\nMore evidence.\n");
  assert.equal(inboxWrittenSince([dir], base), true, "an in-place update of an existing candidate counts");
});

test("an explicit request the turn did not stage goes to the digest, which stages the user's words; no reminder is added", async () => {
  const v = setup();
  const t = { host: "codex", sessionKey: "ex-1", vaultPath: v.root, cwd: v.project, projectId: PID };
  const opts = { now: Date.now(), env: {}, sessionStatePath: v.sessionStatePath, indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => null };
  enrichDecision(explicitDecision(), "记住：发布前先跑 npm run doctor", t, {}, opts);
  // The agent answers but writes nothing.
  enqueueTurnEnd({ host: "codex", sessionKey: "ex-1", assistantText: "好的，我记住了。", sessionStatePath: v.sessionStatePath, queueDir: v.queueDir, scheduleDigest: () => false });
  const recs = readSessionRecords(listQueue(v.queueDir)[0].files);
  assert.deepEqual(recs.map((r) => r.t), ["explicit"], "short reply: only the explicit record");
  // Next turn: no carry-over reminder (the digest has it).
  const next = enrichDecision(plainDecision(), "帮我改一下按钮", t, {}, { ...opts, now: opts.now + 60_000 });
  assert.equal(next.captureCarryOver, undefined);

  const res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir, force: true });
  assert.equal(res.written.length, 1);
  assert.equal(res.written[0].kind, "explicit");
  const [cand] = inboxOf(v);
  assert.match(cand, /auto_kind: "explicit-request"/u);
  assert.match(cand, /> 记住：发布前先跑 npm run doctor/u);
});

test("an explicit request the agent did stage is neither re-asked nor queued", () => {
  const v = setup();
  const t = { host: "codex", sessionKey: "ex-2", vaultPath: v.root, cwd: v.project, projectId: PID };
  const opts = { now: Date.now(), env: {}, sessionStatePath: v.sessionStatePath, indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => null };
  enrichDecision(explicitDecision(), "记住：日志统一用 JSON", t, {}, opts);
  const file = path.join(v.root, "20-Projects", PID, "inbox", "cand-agent.md");
  fs.writeFileSync(file, "---\nstatus: pending-ingest\norigin: user-instruction\n---\n");
  const future = new Date(Date.now() + 5000); fs.utimesSync(file, future, future);
  assert.equal(pendingCaptureEnforcement({ host: "codex", sessionKey: "ex-2", sessionStatePath: v.sessionStatePath, now: opts.now + 1000 }), null);
  enqueueTurnEnd({ host: "codex", sessionKey: "ex-2", assistantText: REPLY(), sessionStatePath: v.sessionStatePath, queueDir: v.queueDir, scheduleDigest: () => false });
  const recs = readSessionRecords(listQueue(v.queueDir)[0].files);
  assert.deepEqual(recs.map((r) => r.t), ["turn"]);
  assert.equal(recs[0].staged, true, "the turn's reply is not a second finding");
});

test("Hermes post_llm_call goes through the session state, so its explicit requests reach the backstop", async () => {
  const v = setup();
  const t = { host: "hermes", sessionKey: "h-1", vaultPath: v.root, cwd: v.project, projectId: PID };
  enrichDecision(explicitDecision(), "记住：周报每周五发", t, {}, { now: Date.now(), env: {}, sessionStatePath: v.sessionStatePath, indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => null });
  const chunks = [];
  await runCli(["--enqueue-turn", "--stdin"], {
    stdin: Readable.from([JSON.stringify({ prompt: "记住：周报每周五发", reply: "好的。", turn: t })]),
    stdout: { write: (s) => chunks.push(s) }, queueDir: v.queueDir, sessionStatePath: v.sessionStatePath, scheduleDigest: () => false
  });
  const recs = readSessionRecords(listQueue(v.queueDir)[0].files);
  assert.deepEqual(recs.map((r) => r.t), ["explicit"]);
});

// ---------------------------------------------------------------- held findings (no project)

test("findingScope: a conclusion without a project is held; a personal statement is Global; project wording is held", () => {
  assert.equal(findingScope("turn", REPLY(), null), "hold");
  assert.equal(findingScope("turn", REPLY(), PID), "project");
  assert.equal(findingScope("statement", "我对花生过敏", null), "global");
  assert.equal(findingScope("statement", "我对花生过敏", PID), "global", "a fact about the user is Global even inside a project");
  assert.equal(findingScope("explicit", "记住：以后回复我都用中文", null), "global");
  assert.equal(findingScope("statement", "以后这个项目的 commit 都用中文", null), "hold");
  assert.equal(findingScope("statement", "以后这个项目的 commit 都用中文", PID), "project");
  assert.equal(findingScope("explicit", "记住：部署前先备份", null), "hold", "an unscoped rule is not guessed into Global");
});

test("held findings are listed, filed with the digest's rules, discarded, and expire after 30 days", async () => {
  const v = setup();
  const t = { host: "codex", sessionKey: "np", vaultPath: v.root, cwd: "/not/a/project" };
  enqueueCapture("turn", { prompt: "修 setup", reply: REPLY(1) }, t, { queueDir: v.queueDir });
  enqueueCapture("statement", { prompt: "我对花生过敏" }, t, { queueDir: v.queueDir });
  const log = path.join(v.stateDir, "digest-log.jsonl");
  const res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir, force: true });
  assert.equal(res.held.length, 1, "the conclusion is held");
  assert.equal(inboxOf(v, "global").length, 1, "the personal fact went to Global");
  assert.equal(inboxOf(v).length, 0);

  // The next turn's hint asks the user about it, once.
  const notice = takeStagedSinceNotice({ logPath: log, stateDir: v.stateDir });
  assert.equal(notice.held, 1);
  assert.match(buildLayaActionNotice({ memoryAction: "default", digestStaged: notice }), /held outside the Vault.*--file <id> --project/su);
  assert.equal(takeStagedSinceNotice({ logPath: log, stateDir: v.stateDir }), null);

  const [held] = listHeld({ stateDir: v.stateDir });
  assert.equal(fileHeld(held.id, { stateDir: v.stateDir, logPath: log }).error, "no_scope");
  assert.equal(fileHeld(held.id, { stateDir: v.stateDir, logPath: log, projectId: "missing-00000000" }).error, "project_not_bound");
  const filed = fileHeld(held.id, { stateDir: v.stateDir, logPath: log, projectId: PID });
  assert.match(filed.path, /^20-Projects\/demo-app-12345678\/inbox\/cand-/u);
  assert.match(inboxOf(v)[0], /auto_kind: "session-conclusion"/u);
  assert.equal(listHeld({ stateDir: v.stateDir }).length, 0);

  const id = holdFinding({ stateDir: v.stateDir, item: { kind: "turn", prompt: "q", reply: REPLY(9), ts: new Date().toISOString() }, host: "codex", session: "s", vaultPath: v.root, textHash: "abc" });
  assert.equal(holdFinding({ stateDir: v.stateDir, item: {}, host: "codex", session: "s", vaultPath: v.root, textHash: "abc" }), null, "held once");
  assert.equal(discardHeld(id, { stateDir: v.stateDir, logPath: log }), true);
  const late = holdFinding({ stateDir: v.stateDir, item: { kind: "turn", prompt: "q", reply: "r", ts: "x" }, host: "codex", session: "s", vaultPath: v.root, textHash: "old", now: Date.now() - 31 * 24 * 3600_000 });
  assert.ok(late);
  assert.equal(listHeld({ stateDir: v.stateDir, logPath: log }).length, 0, "expired");
});

// ---------------------------------------------------------------- Antigravity: the conversation's last turn

test("the final turn of an idle Antigravity conversation is collected once from its transcript", () => {
  const v = setup();
  const dir = tmp("om-gap-agy-");
  const transcript = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcript, [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n第一个问题\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", content: REPLY(1) },
    { type: "USER_INPUT", content: "<USER_REQUEST>\n最后的问题\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", content: REPLY(2) }
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // The hook ran for the second prompt: the first exchange (user line 0) is already queued.
  registerTranscript({ host: "antigravity", sessionKey: "conv-1", transcriptPath: transcript, vaultPath: v.root, cwd: v.project, queuedUserLine: 0, stateDir: v.stateDir });
  assert.equal(antigravityLastExchange(transcript, 0).userLine, 2);
  assert.ok(nextTranscriptDelay({ stateDir: v.stateDir, idleMs: 20 * 60_000 }) > 0, "not idle yet");
  const calls = [];
  const enqueue = (args) => calls.push(args);
  assert.deepEqual(collectIdleTranscripts({ stateDir: v.stateDir, idleMs: 20 * 60_000, enqueue }), [], "still active");
  old(transcript);
  assert.equal(nextTranscriptDelay({ stateDir: v.stateDir, idleMs: 20 * 60_000 }), 0);
  assert.equal(nextDigestDelay({ queueDir: v.queueDir, stateDir: v.stateDir, idleMs: 20 * 60_000 }), 0, "the waiter wakes for it");
  const ready = collectIdleTranscripts({ stateDir: v.stateDir, idleMs: 20 * 60_000, enqueue });
  assert.deepEqual(ready, [sessionIdFor("antigravity", "conv-1")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "最后的问题");
  assert.match(calls[0].assistantText, /第 2 轮/u);
  assert.equal(collectIdleTranscripts({ stateDir: v.stateDir, idleMs: 20 * 60_000, enqueue }).length, 0, "once");
  assert.equal(listTranscripts({ stateDir: v.stateDir })[0].queuedUserLine, 2);
  assert.equal(nextTranscriptDelay({ stateDir: v.stateDir, idleMs: 20 * 60_000 }), null);
});

// ---------------------------------------------------------------- settings

test("one set of environment settings for every host, Hermes' variable name included; the service file follows LAYA_HOME", () => {
  const c = memoryJudgeFromEnv({ OBSIDIAN_MEMORY_ROUTER_MODE: "off", OBSIDIAN_MEMORY_AUTO_CAPTURE: "remind", OBSIDIAN_MEMORY_PROACTIVE_CAPTURE: "off",
    OBSIDIAN_MEMORY_VAULT_HINTS: "0", OBSIDIAN_MEMORY_VAULT_SEMANTIC: "false", OBSIDIAN_MEMORY_DECISION_LOG: "no" });
  assert.deepEqual([c.mode, c.autoCapture, c.proactiveCapture, c.vaultHints, c.vaultSemantic, c.decisionLog], ["off", "remind", false, false, false, false]);
  assert.equal(memoryJudgeFromEnv({ OBSIDIAN_MEMORY_VAULT_HINTS: "maybe" }).vaultHints, true, "unknown values are ignored");
  assert.equal(memoryJudgeFromEnv({ OBSIDIAN_MEMORY_JUDGE_MODE: "auto" }, { mode: "off" }).mode, "off", "host overrides win");
  assert.throws(() => memoryJudgeFromEnv({ OBSIDIAN_MEMORY_JUDGE_MODE: "strict", OBSIDIAN_MEMORY_ENDPOINT: "http://127.0.0.1:1/?token=x" }), "invalid settings still fail closed");
  assert.equal(memoryJudgeModeFromEnv({ OBSIDIAN_MEMORY_JUDGE_MODE: "strict", OBSIDIAN_MEMORY_ENDPOINT: "bad" }), "strict");
  assert.equal(defaultServiceFilePath({ LAYA_HOME: "/data/me" }), path.join("/data/me", ".laya", "service.json"));
});

// ---------------------------------------------------------------- router: explicit recall, bounded backfill, warm-up

function service({ embedDelayMs = 0, embedFail = false, loadAfterPolls = 0 } = {}) {
  let polls = 0;
  const calls = { embed: 0, warmup: 0 };
  const topics = ["symlink", "release", "health"];
  const vec = (t) => { const v = topics.map((k) => (String(t).toLowerCase().includes(k) ? 1 : 0.05)); const n = Math.hypot(...v); return v.map((x) => x / n); };
  const fetch = async (url, options) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body) });
    const health = () => ({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: polls >= loadAfterPolls ? "ready" : "loading", capabilities: ["recall", "embed", "warmup", "capture"] });
    if (u.endsWith("/health")) { polls++; return ok(health()); }
    if (u.endsWith("/warmup")) { calls.warmup++; return ok({ ...health(), warming: true }); }
    const body = JSON.parse(options.body);
    if (u.endsWith("/embed")) {
      calls.embed++;
      if (embedFail) return { ok: false, status: 500, headers: new Map(), text: async () => "" };
      if (embedDelayMs) await new Promise((r) => setTimeout(r, embedDelayMs));
      return ok({ model: "toy", dim: 3, vectors: body.texts.map(vec) });
    }
    if (u.endsWith("/judge/recall")) return ok({ requires_memory: 0.05, confidence: 0.9, query_embedding: vec(body.text), embed_model: "toy" });
    return { ok: false, status: 404, headers: new Map(), text: async () => "" };
  };
  return { fetch, calls, vec };
}

function smallVault() {
  const root = tmp("om-gap-sem-");
  fs.mkdirSync(path.join(root, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(root, "00-System", "projects.yaml"), `projects:\n  - id: ${PID}\n    roots:\n      - /work/demo\n`);
  const wiki = path.join(root, "20-Projects", PID, "wiki", "pitfalls");
  fs.mkdirSync(wiki, { recursive: true });
  for (const [name, body] of [["symlink", "symlink symlink"], ["release", "release steps"], ["health", "health checks"], ["logging", "logging format"], ["database", "database migration"], ["network", "network proxy"]]) {
    fs.writeFileSync(path.join(wiki, `${name}.md`), `---\ntitle: "${name} note"\n---\n\n# ${name}\n\n${body}\n`);
  }
  return root;
}

test("an explicit 'do you remember' turn gets its notes from the retriever, and Vault backfill pauses after a failure", async () => {
  const vault = smallVault();
  const dir = tmp("om-gap-router-");
  const svc = service();
  const opts = (extra = {}) => ({ fetch: svc.fetch, env: {}, vaultIndexCachePath: path.join(dir, "vi.json"), embeddingCachePath: path.join(dir, "ve.json"),
    sessionStatePath: path.join(dir, "ss.json"), decisionLogPath: path.join(dir, "d.jsonl"), embedBackfillStatePath: path.join(dir, "backfill.json"), ...extra });
  const router = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, opts());
  try {
    const turn = { host: "codex", vaultPath: vault, cwd: "/work/demo", projectId: PID };
    await router.evaluateRecall("帮我看看 symlink 的问题", null, turn); // fills the note vectors
    const d = await router.evaluateRecall("你还记得 symlink 那个坑是怎么修的吗", null, turn);
    assert.equal(d.trace.route, "fast_path");
    assert.equal(d.vault?.mode, "semantic");
    assert.match(d.relatedNotes[0], /symlink\.md$/u);
  } finally { router.dispose(); }

  // A failing retriever: one attempt, then no backfill for a while (across router instances).
  const bad = service({ embedFail: true });
  const vault2 = smallVault();
  const r1 = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { ...opts(), fetch: bad.fetch, embeddingCachePath: path.join(dir, "ve2.json"), vaultIndexCachePath: path.join(dir, "vi2.json") });
  try {
    await r1.evaluateRecall("帮我看看 release", null, { host: "codex", vaultPath: vault2, cwd: "/work/demo", projectId: PID });
    const after = bad.calls.embed;
    assert.ok(after >= 1);
    await r1.evaluateRecall("再看看 health", null, { host: "codex", vaultPath: vault2, cwd: "/work/demo", projectId: PID });
    assert.equal(bad.calls.embed, after, "paused");
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "backfill.json"), "utf8")).pausedUntil > Date.now());
  } finally { r1.dispose(); }
});

test("background work waits for an idle-unloaded model; a user's turn never does", async () => {
  const svc = service({ loadAfterPolls: 3 });
  const router = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { fetch: svc.fetch, env: {} });
  try {
    assert.equal(await router.ensureModelReady({ waitMs: 5000, pollMs: 10 }), true);
    assert.equal(svc.calls.warmup, 1);
  } finally { router.dispose(); }
  const never = service({ loadAfterPolls: 1e9 });
  const r2 = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { fetch: never.fetch, env: {} });
  try {
    assert.equal(await r2.ensureModelReady({ waitMs: 50, pollMs: 10 }), false, "bounded");
  } finally { r2.dispose(); }
});

// ---------------------------------------------------------------- index slots, stats, doctor

test("over the note limit every project keeps its newest notes; nothing is dropped silently", () => {
  const c = [];
  for (let i = 0; i < 3; i++) c.push({ file: `g${i}`, projectId: "global", mtimeMs: i });
  for (let i = 0; i < 50; i++) c.push({ file: `a${i}`, projectId: "big", mtimeMs: i });
  for (let i = 0; i < 4; i++) c.push({ file: `b${i}`, projectId: "small", mtimeMs: i });
  for (let i = 0; i < 30; i++) c.push({ file: `z${i}`, projectId: "zlast", mtimeMs: i });
  const { chosen, truncated } = allocateIndexSlots(c, 40);
  assert.equal(chosen.size, 40);
  for (const f of ["g0", "g1", "g2", "b0", "b1", "b2", "b3"]) assert.ok(chosen.has(f), f);
  assert.ok(chosen.has("z29") && chosen.has("a49"), "newest first in each project");
  assert.ok(![...chosen].some((f) => f === "a0"), "oldest dropped first");
  assert.ok(truncated.big > 0 && truncated.zlast > 0);
  assert.equal(truncated.small, undefined);
  assert.equal(allocateIndexSlots(c.slice(0, 10), 40).truncated.big, undefined, "under the limit: everything");
});

test("retention stats read what became of each candidate", () => {
  const v = setup();
  const dir = path.join(v.root, "20-Projects", PID, "inbox");
  const mk = (name, status, kind) => fs.writeFileSync(path.join(dir, name), `---\nstatus: ${status}\nauto_kind: "${kind}"\n---\n`);
  mk("cand-1.md", "pending-ingest", "session-conclusion");
  mk("cand-2.md", "ingested", "session-conclusion");
  mk("cand-3.md", "ingested", "explicit-request");
  const log = path.join(v.stateDir, "digest-log.jsonl");
  const rel = (n) => `20-Projects/${PID}/inbox/${n}`;
  fs.writeFileSync(log, [
    { ts: new Date().toISOString(), vaultPath: v.root, written: [rel("cand-1.md"), rel("cand-2.md")] },
    { ts: new Date().toISOString(), vaultPath: v.root, written: [rel("cand-3.md"), rel("cand-gone.md")] },
    { ts: new Date().toISOString(), held: "held-x", action: "discarded" }
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const s = digestStats({ logPath: log });
  assert.deepEqual([s.written, s.pending, s.ingested, s.removed], [4, 1, 2, 1]);
  assert.equal(s.retention, 0.67);
  assert.equal(s.byKind["session-conclusion"].ingested, 1);
});

test("doctor reports held findings, a full queue and a truncated index", () => {
  const home = tmp("om-gap-doctor-");
  const laya = path.join(home, ".laya");
  fs.mkdirSync(path.join(laya, "state", "held"), { recursive: true });
  fs.writeFileSync(path.join(laya, "state", "held", "held-0123abcd.json"), "{}");
  fs.mkdirSync(path.join(laya, "capture-queue"), { recursive: true });
  fs.writeFileSync(path.join(laya, "capture-queue", "0123456789abcdef.jsonl"), "x".repeat(2 * 1024 * 1024 + 10));
  fs.writeFileSync(path.join(laya, "capture-queue", "fedcba9876543210.1-2.claimed.jsonl"), "{}\n");
  fs.mkdirSync(path.join(laya, "cache"), { recursive: true });
  fs.writeFileSync(path.join(laya, "cache", "vault-index.json"), JSON.stringify({ truncated: { "big-00000000": 12 } }));
  const r = collect({ home, env: {}, packageVersion: "0.8.0" });
  assert.equal(r.digest.queuedSessions, 2, "claimed segments count as queued sessions");
  const text = r.issues.join("\n");
  assert.match(text, /1 finding\(s\) held/u);
  assert.match(text, /reached 2 MB/u);
  assert.match(text, /big-00000000 12/u);
});

// ---------------------------------------------------------------- Laya service: keep loaded weights resident

test("the service touches a loaded, recently used model to keep it resident, without postponing its unload", async (t) => {
  const { findPython } = await import("../scripts/python.mjs");
  const { spawnSync } = await import("node:child_process");
  const python = findPython();
  if (!python) return t.skip("no Python");
  const { fileURLToPath } = await import("node:url");
  const servicePy = fileURLToPath(new URL("../lib/laya-service/service.py", import.meta.url));
  const script = `
import importlib.util, threading, time, sys
spec = importlib.util.spec_from_file_location("svc", ${JSON.stringify(servicePy)})
svc = importlib.util.module_from_spec(spec); spec.loader.exec_module(svc)
class Model:
    def __init__(self, used_ago):
        self.touches = 0
        self.last_used_at = time.monotonic() - used_ago
    def touch(self):
        self.touches += 1
        return True
    def unload_if_idle(self, s):
        return False
class Server:
    pass
server = Server()
server.inference_semaphore = threading.Semaphore(1)
server.backend = Model(0)           # used just now: kept warm
server.embedder = Model(10_000)     # idle past the unload window: left alone
before = server.backend.last_used_at
stop, thread = svc.start_idle_unload_monitor(server, 900, 1)
time.sleep(2.6)
stop.set()
print(server.backend.touches, server.embedder.touches, server.backend.last_used_at == before)
`;
  const r = spawnSync(python.command, [...python.args, "-c", script], { encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const [warm, idle, unchanged] = r.stdout.trim().split(" ");
  assert.ok(Number(warm) >= 1, "touched");
  assert.equal(idle, "0", "a model past its idle window is not kept alive");
  assert.equal(unchanged, "True", "touching is not use");
});
