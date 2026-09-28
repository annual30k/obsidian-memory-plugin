import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { enqueueCapture, readQueueFile, listQueue, sessionIdFor, QUEUE_REPLY_MIN_CHARS } from "../lib/memory-router/capture-queue.js";
import { runDigest, selectSessionFindings, maybeScheduleDigest, acquireDigestLock, renderCandidate, candidateTemplate, waiterAlive, claimWaiter, releaseWaiter, takeStagedSinceNotice } from "../lib/memory-router/digest.js";
import { buildLayaActionNotice, buildGuidance } from "../lib/prompt.js";
import { enrichDecision, enqueueTurnEnd } from "../lib/memory-router/turn-context.js";
import { decideStop } from "../scripts/codex-stop-hook.mjs";
import { previousExchange } from "../scripts/antigravity-hook.mjs";
import { parseArgs as digestArgs, waitAndDigest } from "../scripts/memory-digest.mjs";
import { runCli } from "../lib/memory-router/cli.js";
import { createOpenClawPlugin, lastExchange } from "../index.js";
import { parseMemoryJudgeConfig } from "../lib/config.js";
import { MemoryRouter } from "../lib/memory-router/router.js";

const PID = "demo-app-12345678";
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const REPLY = (n = 1) => `已修复 setup.mjs（第 ${n} 轮）。\n\n原因：existsSync 会跟随软链接，失效链接返回 false，导致跳过删除；链接本身仍占用目标路径，因此创建时报 EEXIST。\n\n修法：去掉存在性判断，直接调用带 force: true 的 rmSync，它删除链接本身而不跟随目标。已用失效链接、正常文件和空路径三种情况验证，行为都符合预期，其他文件没有改动。以后处理链接替换时统一先 lstat 再删除。`;

function makeVault({ initialized = true, rules = "# Rules\n" } = {}) {
  const root = tmp("om-digest-vault-");
  const project = tmp("om-digest-proj-");
  if (initialized) fs.writeFileSync(path.join(root, "AGENTS.md"), "# Vault\n");
  fs.mkdirSync(path.join(root, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(root, "00-System", "projects.yaml"), `projects:\n  - id: ${PID}\n    roots:\n      - ${project}\n    scope: private\n`);
  fs.mkdirSync(path.join(root, "10-Global", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(root, "20-Projects", PID, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(root, "20-Projects", PID, "AGENTS.md"), "# demo\n");
  fs.writeFileSync(path.join(root, "20-Projects", PID, "rules.md"), rules);
  return { root, project };
}

function setup(opts) {
  const v = makeVault(opts);
  const state = tmp("om-digest-state-");
  return { ...v, queueDir: path.join(state, "queue"), stateDir: state };
}

const turn = (v, extra = {}) => ({ host: "codex", sessionKey: "sess-1", vaultPath: v.root, cwd: v.project, ...extra });
const inbox = (v, scope = "project") => fs.readdirSync(scope === "global" ? path.join(v.root, "10-Global", "inbox") : path.join(v.root, "20-Projects", PID, "inbox"));
const old = (file) => { const t = new Date(Date.now() - 3600_000); fs.utimesSync(file, t, t); };

// ---------------------------------------------------------------- queue

test("enqueueCapture keeps long replies only, redacts credentials and writes private files", () => {
  const v = setup();
  assert.equal(enqueueCapture("turn", { prompt: "q", reply: "短回复" }, turn(v), { queueDir: v.queueDir }), null);
  assert.equal(enqueueCapture("nope", { prompt: "q" }, turn(v), { queueDir: v.queueDir }), null);
  assert.equal(enqueueCapture("turn", { prompt: "q", reply: REPLY() }, { ...turn(v), sessionKey: null }, { queueDir: v.queueDir }), null, "no session");
  const rec = enqueueCapture("turn", { prompt: "修一下 setup", reply: REPLY() + " token: api_key=" + ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-") }, turn(v), { queueDir: v.queueDir });
  assert.ok(rec);
  assert.equal(rec.redacted, true);
  assert.doesNotMatch(rec.reply, /sk-abcdefghijklmnop/u);
  assert.ok(rec.keywords >= 2);
  assert.ok(QUEUE_REPLY_MIN_CHARS <= REPLY().length);
  const file = path.join(v.queueDir, `${sessionIdFor("codex", "sess-1")}.jsonl`);
  assert.equal(fs.statSync(file).mode & 0o077, 0, "queue file is private");
  assert.equal(readQueueFile(file).length, 1);
  assert.ok(enqueueCapture("statement", { prompt: "以后都用 sass", score: 0.8 }, turn(v), { queueDir: v.queueDir }));
  assert.equal(enqueueCapture("statement", { prompt: "" }, turn(v), { queueDir: v.queueDir }), null);
});

// ---------------------------------------------------------------- selection

test("a session's findings keep each topic's last conclusion, confirmed fixes first", async () => {
  const recs = [
    { t: "turn", ts: "2026-09-25T01:00:00Z", prompt: "p1", reply: "根因是 A，已修复", keywords: 2 },
    { t: "turn", ts: "2026-09-25T01:05:00Z", prompt: "p2", reply: "普通回复", keywords: 0 },
    { t: "turn", ts: "2026-09-25T01:10:00Z", prompt: "p3", reply: "更正：根因其实是 B，修法改为 C", keywords: 3 },
    { t: "solved", ts: "2026-09-25T01:12:00Z", prompt: "好了" },
    { t: "statement", ts: "2026-09-25T01:20:00Z", prompt: "以后都用 sass" },
    { t: "statement", ts: "2026-09-25T01:21:00Z", prompt: "以后都用  sass" }
  ];
  const one = await selectSessionFindings(recs);
  assert.equal(one.topics.length, 1, "without the retriever a session is one topic");
  assert.equal(one.topics[0].last.prompt, "p3", "the last conclusion wins");
  assert.equal(one.topics[0].members, 2);
  assert.equal(one.topics[0].confirmed, true);
  assert.equal(one.statements.length, 1, "duplicate statements collapse");
  // The capture score rescues a reply with few conclusion words.
  const rescued = await selectSessionFindings(recs, { score: async (t) => (t === "普通回复" ? 0.9 : 0.1) });
  assert.equal(rescued.signalTurns, 3);
  // With the retriever, different topics stay apart.
  const vec = (t) => (t.includes("sass") || t.includes("样式") ? [0, 1] : [1, 0]);
  const two = await selectSessionFindings([
    ...recs.slice(0, 3),
    { t: "turn", ts: "2026-09-25T02:00:00Z", prompt: "样式", reply: "决定：样式统一改为 sass 变量", keywords: 3 }
  ], { embed: async (texts) => texts.map(vec) });
  assert.equal(two.topics.length, 2);
});

// ---------------------------------------------------------------- digest end to end

test("runDigest writes one pending candidate per topic in the project inbox, from the Vault template, then clears the queue", async () => {
  const v = setup();
  fs.mkdirSync(path.join(v.root, "00-System", "templates"), { recursive: true });
  fs.writeFileSync(path.join(v.root, "00-System", "templates", "inbox-memory-candidate.md"),
    `---\nid: "{{candidate_id}}"\ntitle: "{{title}}"\ntype: memory-candidate\nscope: "{{scope}}"\nproject_id: null\nstatus: pending-ingest\ncreated: "{{created}}"\nsource_ref: "{{source_ref}}"\nvault_template_marker: yes\n---\n\n# {{title}}\n\n## Original evidence\n\n## Capture context and reason to retain\n\n## Related canonical notes\n`);
  for (const n of [1, 2, 3]) enqueueCapture("turn", { prompt: `setup.mjs 报 EEXIST，第 ${n} 次排查`, reply: REPLY(n) }, turn(v), { queueDir: v.queueDir });
  const [entry] = listQueue(v.queueDir);
  assert.equal((await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir })).processed, 0, "not idle yet");
  old(entry.file);
  const summary = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  assert.equal(summary.processed, 1);
  assert.equal(summary.written.length, 1);
  assert.equal(summary.written[0].template, "vault");
  const files = inbox(v);
  assert.equal(files.length, 1);
  assert.match(files[0], /^cand-[0-9a-f-]{36}\.md$/u);
  const text = fs.readFileSync(path.join(v.root, "20-Projects", PID, "inbox", files[0]), "utf8");
  assert.match(text, /^status: pending-ingest$/mu);
  assert.match(text, new RegExp(`^project_id: "${PID}"$`, "mu"));
  assert.match(text, /^origin: "auto-digest"$/mu);
  assert.match(text, /^vault_template_marker: yes$/mu);
  assert.match(text, /第 3 轮/u, "the last conclusion is quoted");
  assert.doesNotMatch(text, /第 1 轮/u);
  assert.match(text, /ran over 3 concluding turns/u);
  assert.equal(listQueue(v.queueDir).length, 0, "queue cleared");
  assert.equal(inbox(v, "global").length, 0);
  const log = fs.readFileSync(path.join(v.stateDir, "digest-log.jsonl"), "utf8");
  assert.match(log, new RegExp(files[0]));
  // The same reply queued again for the same session is not written twice.
  enqueueCapture("turn", { prompt: "setup.mjs 报 EEXIST，第 3 次排查", reply: REPLY(3) }, turn(v), { queueDir: v.queueDir });
  const again = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir, force: true });
  assert.deepEqual(again.skipped.map((s) => s.reason), ["already_digested"]);
  assert.equal(inbox(v).length, 1);
});

test("the digest never guesses a scope and honours the Vault's rules", async () => {
  // No project resolvable: nothing is steered into Global.
  const a = setup();
  enqueueCapture("turn", { prompt: "q", reply: REPLY() }, { ...turn(a), cwd: "/somewhere/else" }, { queueDir: a.queueDir });
  const ra = await runDigest({ queueDir: a.queueDir, stateDir: a.stateDir, force: true });
  assert.deepEqual(ra.skipped.map((s) => s.reason), ["no_project"]);
  assert.equal(inbox(a, "global").length, 0);

  // Uninitialized Vault.
  const b = setup({ initialized: false });
  enqueueCapture("turn", { prompt: "q", reply: REPLY() }, turn(b), { queueDir: b.queueDir });
  assert.deepEqual((await runDigest({ queueDir: b.queueDir, stateDir: b.stateDir, force: true })).skipped.map((s) => s.reason), ["vault_not_initialized"]);

  // Project opt-out in rules.md.
  const c = setup({ rules: "# Rules\nno-auto-capture\n" });
  enqueueCapture("turn", { prompt: "q", reply: REPLY() }, turn(c), { queueDir: c.queueDir });
  assert.deepEqual((await runDigest({ queueDir: c.queueDir, stateDir: c.stateDir, force: true })).skipped.map((s) => s.reason), ["project_opt_out"]);

  // A finding that contained a credential is not written at all.
  const d = setup();
  enqueueCapture("turn", { prompt: "q", reply: REPLY() + " password=hunter2" }, turn(d), { queueDir: d.queueDir });
  assert.deepEqual((await runDigest({ queueDir: d.queueDir, stateDir: d.stateDir, force: true })).skipped.map((s) => s.reason), ["sensitive_content"]);
  assert.equal(inbox(d).length, 0);

  // Dry run: reports, writes nothing, keeps the queue.
  const e = setup();
  enqueueCapture("turn", { prompt: "q", reply: REPLY() }, turn(e), { queueDir: e.queueDir });
  const re = await runDigest({ queueDir: e.queueDir, stateDir: e.stateDir, force: true, dryRun: true });
  assert.equal(re.written.length, 1);
  assert.equal(inbox(e).length, 0);
  assert.equal(listQueue(e.queueDir).length, 1);
});

test("user statements become candidates: cross-project ones in Global, others in the project", async () => {
  const v = setup();
  enqueueCapture("statement", { prompt: "以后这个项目的 commit message 都用中文写", score: 0.81 }, turn(v), { queueDir: v.queueDir });
  enqueueCapture("statement", { prompt: "全局偏好：回答一律用中文", score: 0.9 }, turn(v, { sessionKey: "sess-2" }), { queueDir: v.queueDir });
  const summary = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir, force: true });
  assert.equal(summary.written.length, 2);
  assert.equal(inbox(v).length, 1);
  assert.equal(inbox(v, "global").length, 1);
  const g = fs.readFileSync(path.join(v.root, "10-Global", "inbox", inbox(v, "global")[0]), "utf8");
  assert.match(g, /^scope: "?global"?$/mu);
  assert.match(g, /^project_id: null$/mu);
  assert.match(g, /auto_kind: "user-statement"/u);
});

test("the bundled template renders valid frontmatter with provenance keys", () => {
  const { text, source } = candidateTemplate(tmp("om-empty-"));
  assert.equal(source, "bundled");
  const out = renderCandidate(text, {
    id: "cand-x", title: 'A "quoted" title', scope: "project", created: "2026-09-25T00:00:00.000Z", sourceRef: "codex session s",
    projectId: PID, evidence: "- e", context: "c", related: "- None", meta: { origin: "auto-digest", source_session: "s" }
  });
  assert.match(out, /^id: "cand-x"$/mu);
  assert.match(out, /^title: "A \\"quoted\\" title"$/mu);
  assert.match(out, /^origin: "auto-digest"$/mu);
  assert.match(out, /## Original evidence\n\n- e/u);
  const fm = out.slice(0, out.indexOf("\n---", 3));
  assert.doesNotMatch(fm, /\{\{/u);
});

// ---------------------------------------------------------------- scheduling

test("hooks start the digest only when a session is idle, not twice in a row, and not while one runs", () => {
  const v = setup();
  const spawned = [];
  const spawn = (cmd, args) => spawned.push(args);
  assert.equal(maybeScheduleDigest({ queueDir: v.queueDir, stateDir: v.stateDir, spawn, env: {} }), false, "empty queue");
  enqueueCapture("turn", { prompt: "q", reply: REPLY() }, turn(v), { queueDir: v.queueDir });
  assert.equal(maybeScheduleDigest({ queueDir: v.queueDir, stateDir: v.stateDir, spawn, env: {} }), "waiter", "session still active: a waiter will come back");
  assert.deepEqual(spawned[0].slice(1), ["--auto", "--wait"]);
  assert.equal(maybeScheduleDigest({ queueDir: v.queueDir, stateDir: v.stateDir, spawn, env: {} }), false, "one waiter at a time");
  old(listQueue(v.queueDir)[0].file);
  assert.equal(maybeScheduleDigest({ queueDir: v.queueDir, stateDir: v.stateDir, spawn, env: {} }), true);
  assert.match(spawned[1][0], /memory-digest\.mjs$/u);
  assert.deepEqual(spawned[1].slice(1), ["--auto"]);
  assert.equal(maybeScheduleDigest({ queueDir: v.queueDir, stateDir: v.stateDir, spawn, env: {} }), false, "ran moments ago");
  const release = acquireDigestLock(v.stateDir);
  assert.ok(release);
  assert.equal(acquireDigestLock(v.stateDir), null, "one digest at a time");
  release();
  assert.ok(acquireDigestLock(v.stateDir));
  assert.deepEqual(digestArgs(["--now", "--dry-run", "--session", "abc"]), { auto: false, force: true, dryRun: true, json: false, wait: false, sessions: ["abc"] });
});

test("the waiter digests once the queue is idle and exits when it is empty; one live waiter at a time", async () => {
  const v = setup();
  enqueueCapture("turn", { prompt: "q", reply: REPLY() }, turn(v), { queueDir: v.queueDir });
  let clock = Date.now();
  const slept = [];
  const runs = await waitAndDigest({
    queueDir: v.queueDir, idleMs: 20 * 60 * 1000, now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; old(listQueue(v.queueDir)[0].file); },
    digestOnce: async () => runDigest({ queueDir: v.queueDir, stateDir: v.stateDir, now: clock })
  });
  assert.equal(runs, 1);
  assert.ok(slept.length >= 1 && slept[0] > 0, "slept until the session went idle");
  assert.equal(listQueue(v.queueDir).length, 0);
  assert.equal(inbox(v).length, 1, "the conclusion was staged without any further hook");

  assert.equal(claimWaiter(v.stateDir, process.pid), true);
  assert.equal(waiterAlive(v.stateDir), true);
  assert.equal(claimWaiter(v.stateDir, process.pid + 1), false, "a second waiter backs off");
  releaseWaiter(v.stateDir, process.pid);
  assert.equal(waiterAlive(v.stateDir), false);
});

test("digest keeps a queue when the Vault is unreadable, digests stale queues first, and logs every outcome", async () => {
  const v = setup();
  const log = path.join(v.stateDir, "digest-log.jsonl");
  const gone = path.join(v.stateDir, "unmounted-vault");
  enqueueCapture("turn", { prompt: "修一下 setup", reply: REPLY() }, { ...turn(v), vaultPath: gone, sessionKey: "away" }, { queueDir: v.queueDir });
  old(listQueue(v.queueDir)[0].file);
  let res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  assert.ok(res.skipped.some((s) => s.reason === "vault_unreadable"));
  assert.equal(listQueue(v.queueDir).length, 1, "kept for a later run");
  assert.equal(JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop()).kept, true);

  // Older than 7 days and still unreadable: dropped, and the log says so.
  const week = new Date(Date.now() - 8 * 24 * 3600_000);
  fs.utimesSync(listQueue(v.queueDir)[0].file, week, week);
  res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  assert.ok(res.skipped.some((s) => s.reason === "stale_queue_dropped"));
  assert.equal(listQueue(v.queueDir).length, 0);

  // Older than 7 days but digestible: written, not silently deleted.
  enqueueCapture("turn", { prompt: "修一下 setup", reply: REPLY() }, { ...turn(v), sessionKey: "late" }, { queueDir: v.queueDir });
  fs.utimesSync(listQueue(v.queueDir)[0].file, week, week);
  res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  assert.equal(res.written.length, 1);
  assert.equal(inbox(v).length, 1);
});

test("the next turn tells the user once what the digest staged", async () => {
  const v = setup();
  enqueueCapture("turn", { prompt: "修一下 setup", reply: REPLY() }, turn(v), { queueDir: v.queueDir });
  old(listQueue(v.queueDir)[0].file);
  await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  const logPath = path.join(v.stateDir, "digest-log.jsonl");
  const staged = takeStagedSinceNotice({ logPath, stateDir: v.stateDir });
  assert.equal(staged.count, 1);
  assert.match(staged.paths[0], /^20-Projects\/.+\/inbox\/cand-/u);
  assert.equal(takeStagedSinceNotice({ logPath, stateDir: v.stateDir }), null, "announced once");

  const decision = enrichDecision({ memoryAction: "skip", score: 0.05, trace: { route: "laya" } }, "帮我改一下按钮颜色",
    { host: "codex", sessionKey: "n1", vaultPath: v.root, cwd: v.project }, {},
    { sessionStatePath: path.join(v.stateDir, "s.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => staged, env: {} });
  assert.deepEqual(decision.digestStaged, staged);
  const notice = buildLayaActionNotice(decision);
  assert.match(notice, /memory not needed/u, "the turn's own hint stays");
  assert.match(notice, /staged 1 pending-ingest candidate/u);
  assert.match(buildGuidance({ vaultPath: v.root, cliPath: "obsidian" }, decision), /staged 1 pending-ingest candidate/u, "compact skip block too");
  assert.equal(buildLayaActionNotice({ memoryAction: "default", trace: { route: "laya" } }), null);
});

test("a turn holding a modern API key is never written to the Vault", async () => {
  const v = setup();
  enqueueCapture("turn", { prompt: "配置好了吗", reply: REPLY() + `\n已把 OPENAI 的 key 换成 ${["sk-proj", "AbCdEf0123456789AbCdEf0123456789"].join("-")} 并重启。` }, turn(v), { queueDir: v.queueDir });
  old(listQueue(v.queueDir)[0].file);
  const res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  assert.equal(res.written.length, 0);
  assert.ok(res.skipped.some((x) => x.reason === "sensitive_content"));
  assert.equal(inbox(v).length, 0);
});

test("digest quality: identical conclusions once, no generic Q&A, no double write after an explicit save, useful titles, project scope for 'globalThis'", async () => {
  const v = setup();
  // Same conclusion in two sessions (wording identical up to whitespace).
  enqueueCapture("turn", { prompt: "修一下 setup", reply: REPLY() }, turn(v, { sessionKey: "d1" }), { queueDir: v.queueDir });
  enqueueCapture("turn", { prompt: "继续", reply: REPLY().replace(/\n\n/gu, "\n") }, turn(v, { sessionKey: "d2" }), { queueDir: v.queueDir });
  // A general knowledge answer full of weak conclusion words.
  enqueueCapture("turn", { prompt: "import 和 require 有什么区别", reply: "在 Node 里 ESM 只能用 import，CommonJS 改为用 require；不再推荐混用。".repeat(4) }, turn(v, { sessionKey: "d3" }), { queueDir: v.queueDir });
  // The agent already staged this turn's explicit save.
  enqueueCapture("turn", { prompt: "记住：以后都用 pnpm", reply: REPLY(2), staged: true }, turn(v, { sessionKey: "d4" }), { queueDir: v.queueDir });
  // A statement mentioning globalThis stays in the project.
  enqueueCapture("statement", { prompt: "以后这个项目统一用 globalThis，别再用 window", score: 0.9 }, turn(v, { sessionKey: "d5" }), { queueDir: v.queueDir });
  for (const e of listQueue(v.queueDir)) old(e.file);
  const res = await runDigest({ queueDir: v.queueDir, stateDir: v.stateDir });
  const reasons = res.skipped.map((x) => x.reason);
  assert.ok(reasons.includes("duplicate"), "the second copy is a duplicate");
  assert.equal(res.written.filter((w) => w.kind === "turn").length, 1);
  assert.equal(res.written.filter((w) => w.kind === "statement").length, 1);
  assert.equal(inbox(v, "global").length, 0, "'globalThis' is not the Global scope");
  const files = inbox(v).map((f) => fs.readFileSync(path.join(v.root, "20-Projects", PID, "inbox", f), "utf8"));
  const turnFile = files.find((t) => /session-conclusion/u.test(t));
  assert.match(turnFile, /^title: "修一下 setup"$/mu);
  assert.match(turnFile, /^source_hash: "[0-9a-f]{16}"$/mu);
  assert.ok(!files.some((t) => /import 和 require/u.test(t)), "generic Q&A not written");
  assert.ok(!files.some((t) => /pnpm/u.test(t)), "explicit save not written twice");

  // A continuation request gives no title: the conclusion's first line does.
  const w = setup();
  enqueueCapture("turn", { prompt: "继续", reply: REPLY(3) }, turn(w), { queueDir: w.queueDir });
  old(listQueue(w.queueDir)[0].file);
  await runDigest({ queueDir: w.queueDir, stateDir: w.stateDir });
  const t = fs.readFileSync(path.join(w.root, "20-Projects", PID, "inbox", inbox(w)[0]), "utf8");
  assert.match(t, /^title: "已修复 setup\.mjs（第 3 轮）。"$/mu);
});

test("renderCandidate fills a hand-written '<…>' template and a CRLF template keeps its provenance", () => {
  const vault = "---\r\ntitle: <Memory candidate title>\r\ntype: inbox-memory-candidate\r\nstatus: pending-ingest\r\ncaptured: YYYY-MM-DD\r\nproject_id: <project_id or global>\r\norigin: <user-instruction | task-result>\r\nsensitivity: <internal | confidential>\r\n---\r\n\r\n# <Memory candidate title>\r\n\r\n## Candidate evidence\r\n\r\n<Accurate, minimal record.>\r\n\r\n## Source reference\r\n\r\n<Task or file.>\r\n\r\n## Capture context\r\n\r\n<Context.>\r\n\r\n## Ingest state\r\n\r\nPending.\r\n";
  const out = renderCandidate(vault, { id: "cand-1", title: "标题: 含冒号", scope: "project", created: "2026-09-28T10:00:00.000Z", sourceRef: "codex session s", projectId: PID, evidence: "> 证据", context: "上下文", related: "- none", meta: { origin: "auto-digest", source_hash: "abc" } });
  assert.doesNotMatch(out, /\r|<[^>\n]*>|YYYY/u);
  assert.match(out, /^title: "标题: 含冒号"$/mu);
  assert.match(out, /^captured: 2026-09-28$/mu);
  assert.match(out, /^origin: "auto-digest"$/mu);
  assert.equal(out.match(/^origin:/gmu).length, 1);
  assert.match(out, /^sensitivity: internal$/mu);
  assert.match(out, /^# 标题: 含冒号$/mu);
  assert.match(out, /## Candidate evidence\n\n> 证据/u);
  assert.match(out, /## Source reference\n\ncodex session s/u);
  assert.match(out, /## Ingest state\n\nPending\./u);
  assert.match(out, /## Related canonical notes\n\n- none/u);
});

test("enqueueTurnEnd marks a turn whose explicit save the agent already staged", () => {
  const v = setup();
  const statePath = path.join(v.stateDir, "s.json");
  const t = turn(v, { sessionKey: "ex-1", projectId: PID });
  const opts = { now: Date.now(), env: {}, sessionStatePath: statePath, indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => null };
  enrichDecision({ memoryAction: "capture", captureRecommended: true, captureKind: "explicit", reason: "explicit_remember_intent", trace: { route: "fast_path" } }, "记住：以后都用 pnpm", t, {}, opts);
  const dir = path.join(v.root, "20-Projects", PID, "inbox");
  fs.writeFileSync(path.join(dir, "cand-agent.md"), "---\nstatus: pending-ingest\n---\n");
  const later = new Date(Date.now() + 2000); fs.utimesSync(dir, later, later);
  const rec = enqueueTurnEnd({ host: "codex", sessionKey: "ex-1", assistantText: REPLY(), sessionStatePath: statePath, queueDir: v.queueDir, scheduleDigest: () => false });
  assert.equal(rec.staged, true);
});

test("a host-internal message is not queued as a user statement even with a high durable score", () => {
  const v = setup();
  const opts = { now: Date.now(), env: {}, sessionStatePath: path.join(v.stateDir, "s.json"), indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => null };
  const d = { memoryAction: "skip", reason: "system_message", trace: { route: "fast_path" }, durableCandidate: true, durableScore: 0.966 };
  enrichDecision(d, "__openclaw_memory_core_short_term_promotion_dream__", turn(v, { sessionKey: "sys" }), {}, opts);
  assert.equal(listQueue(v.queueDir).length, 0);
});

// ---------------------------------------------------------------- hosts

test("digest mode: prompt-time statements and 'it works now' go to the queue, not into a hint", () => {
  const v = setup();
  const statePath = path.join(v.stateDir, "session-state.json");
  const opts = { now: Date.now(), env: {}, sessionStatePath: statePath, indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false };
  const t = turn(v);
  const d = { recallRecommended: false, captureRecommended: false, score: 0.1, reason: "laya_below_threshold", blocked: false, memoryAction: "skip", durableCandidate: true, durableScore: 0.8, trace: { route: "laya" } };
  enrichDecision(d, "以后这个项目的日志统一用 JSON", t, {}, opts);
  enrichDecision({ ...d, durableCandidate: false, memoryAction: "default" }, "为什么一直报错 ECONNREFUSED，排查一下", t, {}, { ...opts, now: opts.now + 1000 });
  const solved = enrichDecision({ ...d, durableCandidate: false }, "好了，现在可以了", t, {}, { ...opts, now: opts.now + 2000 });
  assert.equal(solved.pitfallCheck, undefined, "no hint in digest mode");
  const recs = readQueueFile(listQueue(v.queueDir)[0].file);
  assert.deepEqual(recs.map((r) => r.t), ["statement", "solved"]);
  assert.equal(recs[0].projectId, PID, "project resolved from the cwd");
});

test("router: in digest mode a durable statement is queued, never hinted", async () => {
  const mockFetch = async (url) => String(url).endsWith("/health")
    ? { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: "ready", capabilities: ["recall"] }) }
    : { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: 0.1, confidence: 0.9, durable_statement: 0.9, durable_head: true }) };
  const router = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { fetch: mockFetch, env: {} });
  try {
    const d = await router.evaluateRecall("以后都用 sass");
    assert.equal(d.captureRecommended, false);
    assert.equal(d.durableCandidate, true);
    assert.equal(d.memoryAction, "skip");
  } finally { router.dispose(); }
});

test("router (digest): a lasting statement is queued even when recall fires, from 0.5 up", async () => {
  const answers = { recall: 0.9, durable: 0.6 };
  const mockFetch = async (url) => String(url).endsWith("/health")
    ? { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: "ready", capabilities: ["recall"] }) }
    : { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: answers.recall, confidence: 0.9, durable_statement: answers.durable, durable_head: true }) };
  const router = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18792" }, { fetch: mockFetch, env: {} });
  try {
    let d = await router.evaluateRecall("以后测试统一放 tests/ 目录");
    assert.equal(d.recallRecommended, true);
    assert.equal(d.durableCandidate, true, "queued alongside the recall hint");
    answers.durable = 0.45;
    d = await router.evaluateRecall("以后测试统一放 tests/ 目录");
    assert.equal(d.durableCandidate, undefined);
  } finally { router.dispose(); }
});

test("digest mode queues a rule or preference by its wording, but not a question or an explicit save", () => {
  const v = setup();
  const t = turn(v, { sessionKey: "w-1" });
  const opts = { now: Date.now(), env: {}, sessionStatePath: path.join(v.stateDir, "s.json"), indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false, takeStaged: () => null };
  const plain = { recallRecommended: false, score: 0.1, reason: "laya_below_threshold", blocked: false, memoryAction: "skip", trace: { route: "laya" } };
  enrichDecision({ ...plain }, "我对花生过敏", t, {}, opts);
  enrichDecision({ ...plain }, "我们约定的是什么？", t, {}, { ...opts, now: opts.now + 1000 });
  enrichDecision({ memoryAction: "capture", captureRecommended: true, reason: "explicit_remember_intent", trace: { route: "fast_path" } }, "记住：以后都用 pnpm", t, {}, { ...opts, now: opts.now + 2000 });
  enrichDecision({ ...plain }, "以后回复都用中文", t, { proactiveCapture: false }, { ...opts, now: opts.now + 3000 });
  const recs = readQueueFile(listQueue(v.queueDir)[0].file);
  assert.deepEqual(recs.map((r) => r.prompt), ["我对花生过敏"]);
});

test("Codex Stop hook (digest): queues the turn with the prompt from the session state and never blocks, except for an unstaged explicit request", () => {
  const v = setup();
  const statePath = path.join(v.stateDir, "session-state.json");
  const t = turn(v, { sessionKey: "cx-1" });
  const eopts = { now: Date.now(), env: {}, sessionStatePath: statePath, indexCachePath: path.join(v.stateDir, "vi.json"), queueDir: v.queueDir, scheduleDigest: () => false };
  enrichDecision({ recallRecommended: false, score: 0.1, reason: "x", blocked: false, memoryAction: "skip", trace: { route: "laya" } }, "setup.mjs 报 EEXIST，修一下", t, {}, eopts);
  const config = parseMemoryJudgeConfig({ mode: "auto" });
  const opts = { sessionStatePath: statePath, now: eopts.now + 1000, config, queueDir: v.queueDir, scheduleDigest: () => false };
  assert.equal(decideStop({ session_id: "cx-1", last_assistant_message: REPLY() }, opts), null);
  assert.equal(decideStop({ session_id: "cx-1", last_assistant_message: REPLY() }, opts), null);
  const recs = readQueueFile(listQueue(v.queueDir)[0].file);
  assert.equal(recs.length, 1, "once per reply");
  assert.equal(recs[0].prompt, "setup.mjs 报 EEXIST，修一下");
  assert.equal(recs[0].projectId, PID);
  // Explicit request still enforced.
  const explicit = { recallRecommended: false, captureRecommended: true, captureKind: "explicit", scope: "project", reason: "explicit_remember_intent", blocked: false, memoryAction: "capture", trace: { route: "fast_path" } };
  enrichDecision(explicit, "记住：日志统一用 JSON", { ...t, sessionKey: "cx-2" }, {}, eopts);
  assert.equal(decideStop({ session_id: "cx-2", last_assistant_message: REPLY() }, { ...opts, now: eopts.now + 2000 })?.decision, "block");
});

test("enqueueTurnEnd queues a reply once and uses an explicit prompt when given", () => {
  const v = setup();
  const statePath = path.join(v.stateDir, "s.json");
  const args = { host: "hermes", sessionKey: "h1", assistantText: REPLY(), prompt: "hermes 的问题", turn: { vaultPath: v.root, cwd: v.project }, sessionStatePath: statePath, queueDir: v.queueDir, scheduleDigest: () => false };
  assert.ok(enqueueTurnEnd(args));
  assert.equal(readQueueFile(listQueue(v.queueDir)[0].file)[0].prompt, "hermes 的问题");
});

test("OpenClaw agent_end queues the run's request and final reply", async () => {
  const v = setup();
  const dir = tmp("om-oc-digest-");
  const prev = process.env.OBSIDIAN_MEMORY_LAYA_DIR;
  process.env.OBSIDIAN_MEMORY_LAYA_DIR = dir;
  try {
    const registered = [];
    createOpenClawPlugin({ routerFactory: () => ({ evaluateRecall: async () => ({ memoryAction: "default", trace: { route: "laya" } }), dispose() {} }) }).register({
      pluginConfig: { agentConfigs: { main: { vaultPath: v.root, cliPath: "obsidian", projectId: PID } }, memoryJudge: { mode: "manual", endpoint: "http://127.0.0.1:1" } },
      on: (name, handler) => registered.push({ name, handler }),
      logger: { debug() {}, info() {}, warn() {} }
    });
    const end = registered.find((r) => r.name === "agent_end").handler;
    const messages = [
      { role: "user", content: [{ type: "text", text: "为什么图片不显示" }] },
      { role: "assistant", content: [{ type: "tool_use" }] },
      { role: "tool", content: "ok" },
      { role: "assistant", content: [{ type: "text", text: REPLY() }] }
    ];
    assert.deepEqual(lastExchange(messages), { prompt: "为什么图片不显示", reply: REPLY() });
    end({ success: false, messages }, { agentId: "main", sessionKey: "oc-1" });
    end({ success: true, messages }, { agentId: "main", sessionKey: "oc-1" });
    const q = path.join(dir, "capture-queue");
    const recs = readQueueFile(listQueue(q)[0].file);
    assert.equal(recs.length, 1, "failed runs are not queued");
    assert.equal(recs[0].host, "openclaw");
    assert.equal(recs[0].projectId, PID);
    assert.equal(recs[0].prompt, "为什么图片不显示");
  } finally {
    process.env.OBSIDIAN_MEMORY_LAYA_DIR = prev;
  }
});

test("OpenClaw agent_end skips cron/heartbeat runs, failed model calls and repeated reports", async () => {
  const v = setup();
  const dir = tmp("om-oc-digest-");
  const prev = process.env.OBSIDIAN_MEMORY_LAYA_DIR;
  process.env.OBSIDIAN_MEMORY_LAYA_DIR = dir;
  try {
    const registered = [];
    createOpenClawPlugin({ routerFactory: () => ({ evaluateRecall: async () => ({ memoryAction: "default", trace: { route: "laya" } }), dispose() {} }) }).register({
      pluginConfig: { agentConfigs: { main: { vaultPath: v.root, cliPath: "obsidian", projectId: PID } }, memoryJudge: { mode: "manual", endpoint: "http://127.0.0.1:1" } },
      on: (name, handler) => registered.push({ name, handler }),
      logger: { debug() {}, info() {}, warn() {} }
    });
    const end = registered.find((r) => r.name === "agent_end").handler;
    const history = [
      { role: "user", content: [{ type: "text", text: "旧问题" }] },
      { role: "assistant", content: [{ type: "text", text: REPLY(1) }] }
    ];
    // Live failure (2026-09-25/26): a cron run whose model call failed replayed an old reply from history.
    const failed = [...history, { role: "user", content: [{ type: "text", text: "[cron:x nightly] 复盘" }] }, { role: "assistant", content: [], stopReason: "error", errorMessage: "ECONNRESET" }];
    assert.deepEqual(lastExchange(failed), { prompt: "", reply: "" }, "an errored final message never reaches back into history");
    assert.deepEqual(lastExchange([...history, { role: "assistant", content: [] }]), { prompt: "", reply: "" });
    end({ success: true, messages: failed }, { agentId: "main", sessionKey: "oc-2", trigger: "user" });
    end({ success: true, messages: history }, { agentId: "main", sessionKey: "oc-2", trigger: "cron" });
    end({ success: true, messages: history }, { agentId: "main", sessionKey: "oc-2", trigger: "heartbeat" });
    end({ success: true, error: "prompt error", messages: history }, { agentId: "main", sessionKey: "oc-2" });
    const q = path.join(dir, "capture-queue");
    assert.equal(listQueue(q).length, 0, "nothing queued from non-user or failed runs");
    end({ success: true, messages: history }, { agentId: "main", sessionKey: "oc-2", trigger: "user" });
    end({ success: true, messages: history }, { agentId: "main", sessionKey: "oc-2", trigger: "user" });
    assert.equal(readQueueFile(listQueue(q)[0].file).length, 1, "the same turn reported twice is queued once");
  } finally {
    process.env.OBSIDIAN_MEMORY_LAYA_DIR = prev;
  }
});

test("Antigravity: the previous turn is read from the transcript", () => {
  const dir = tmp("om-agy-");
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, [
    { type: "USER_INPUT", content: "<USER_REQUEST>\n为什么构建失败\n</USER_REQUEST>" },
    { type: "PLANNER_RESPONSE", tool_calls: [] },
    { type: "PLANNER_RESPONSE", content: "中间说明" },
    { type: "PLANNER_RESPONSE", content: REPLY() },
    { type: "USER_INPUT", content: "<USER_REQUEST>好的</USER_REQUEST>" }
  ].map((r) => JSON.stringify(r)).join("\n"));
  assert.deepEqual(previousExchange(file, 4), { prompt: "为什么构建失败", reply: REPLY() });
  assert.equal(previousExchange(file, 0), null);
  assert.equal(previousExchange(path.join(dir, "missing"), 3), null);
});

test("CLI --enqueue-turn (Hermes post_llm_call) queues one turn and reports it", async () => {
  const v = setup();
  let out = "";
  const stdout = { write: (s) => { out += s; } };
  const input = JSON.stringify({ prompt: "hermes 问题", reply: REPLY(), turn: { host: "hermes", sessionKey: "h-9", vaultPath: v.root, cwd: v.project } });
  await runCli(["--enqueue-turn", "--stdin"], { stdin: Readable.from([input]), stdout, queueDir: v.queueDir, scheduleDigest: () => false });
  assert.deepEqual(JSON.parse(out), { queued: true });
  out = "";
  await runCli(["--enqueue-turn", "--stdin"], { stdin: Readable.from(["not json"]), stdout, queueDir: v.queueDir, scheduleDigest: () => false });
  assert.deepEqual(JSON.parse(out), { queued: false });
});
