import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enrichDecision, pendingCaptureEnforcement, inboxSignature, inboxScope, sessionIdFor, judgeTurnEndCapture, turnEndNeedsScore, conclusionKeywordCount } from "../lib/memory-router/turn-context.js";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { buildLayaActionNotice, memoryActionFor } from "../lib/prompt.js";
import { validateRecallResponse } from "../lib/memory-router/schemas.js";
import { decideStop, lastAssistantMessageFromTranscript, judgeConfigFromEnv } from "../scripts/codex-stop-hook.mjs";
import { parseMemoryJudgeConfig } from "../lib/config.js";
import { createOpenClawPlugin } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-cap-vault-"));
  fs.mkdirSync(path.join(root, "20-Projects", "app-12345678", "inbox"), { recursive: true });
  fs.mkdirSync(path.join(root, "10-Global", "inbox"), { recursive: true });
  return root;
}

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-cap-turn-"));
  return { now: 1_000_000, env: {}, indexCachePath: path.join(dir, "vault-index.json"), sessionStatePath: path.join(dir, "session-state.json"), decisionLogPath: path.join(dir, "decisions.jsonl") };
}

const explicitCapture = () => ({
  recallRecommended: false, captureRecommended: true, captureCategory: "decision", captureKind: "explicit", scope: "project",
  reason: "explicit_remember_intent", blocked: false, memoryAction: "capture", trace: { route: "fast_path", decision: "capture" }
});
const layaDecision = (score, action) => ({
  recallRecommended: action === "recall", captureRecommended: false, score, reason: "laya_below_threshold",
  blocked: false, memoryAction: action, trace: { route: "laya", decision: "none" }
});

test("schemas pass the durable-statement score through only with its head flag", () => {
  const base = { requires_memory: 0.1, confidence: 0.9 };
  assert.equal(validateRecallResponse(base).durableStatement, undefined);
  const r = validateRecallResponse({ ...base, durable_statement: 0.82, durable_head: true });
  assert.equal(r.durableStatement, 0.82);
  assert.equal(r.durableHead, true);
  assert.equal(validateRecallResponse({ ...base, durable_statement: 1.5 }).durableStatement, undefined);
});

test("the router turns a confident durable-statement score into a capture check, never over a recall or a generic question", async () => {
  const answers = { durable: 0.9, recall: 0.1 };
  const mockFetch = async (url, options) => {
    const u = String(url);
    if (u.endsWith("/health")) return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: "ready", capabilities: ["recall"] }) };
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: answers.recall, confidence: 0.9, categories: { knowledge: 0.7, decision: 0.2, pitfall: 0.1 }, durable_statement: answers.durable, durable_head: true, echo: body.text }) };
  };
  const router = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791", autoCapture: "revise" }, { fetch: mockFetch, env: {} });
  try {
    const d = await router.evaluateRecall("以后所有接口错误码都用 E 开头的四位数");
    assert.equal(d.captureRecommended, true);
    assert.equal(d.captureKind, "durable");
    assert.equal(d.captureCategory, "knowledge");
    assert.equal(d.reason, "durable_statement");
    assert.equal(d.memoryAction, "capture");
    const notice = buildLayaActionNotice(d);
    assert.match(notice, /seems to state a lasting rule/u);
    assert.match(notice, /likely a knowledge/u);
    assert.match(notice, /if not, do nothing/u);

    answers.durable = 0.5;
    const low = await router.evaluateRecall("以后所有接口错误码都用 E 开头的四位数");
    assert.equal(low.captureRecommended, false);
    assert.equal(low.memoryAction, "skip");

    answers.durable = 0.9; answers.recall = 0.9;
    const recall = await router.evaluateRecall("我们之前定的错误码规则是什么");
    assert.equal(recall.recallRecommended, true);
    assert.equal(recall.captureRecommended, false, "recall wins over a capture check");

    answers.recall = 0.1;
    const generic = await router.evaluateRecall("HTTP 状态码 4xx 和 5xx 有什么区别");
    assert.equal(generic.captureRecommended, false, "a general question is never a durable statement");
  } finally {
    router.dispose();
  }
});

test("a durable-statement score without a trained head, or with proactiveCapture off, gives no capture hint", async () => {
  const make = (extra) => async (url) => String(url).endsWith("/health")
    ? { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ service: "laya-memory-judge", status: "ok", api_version: "1", model_status: "ready", capabilities: ["recall"] }) }
    : { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ requires_memory: 0.1, confidence: 0.9, ...extra }) };
  const noHead = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791" }, { fetch: make({ durable_statement: 0.95, durable_head: false }), env: {} });
  const off = new MemoryRouter({ mode: "manual", endpoint: "http://127.0.0.1:18791", proactiveCapture: false }, { fetch: make({ durable_statement: 0.95, durable_head: true }), env: {} });
  try {
    assert.equal((await noHead.evaluateRecall("以后都用 sass")).captureRecommended, false);
    assert.equal((await off.evaluateRecall("以后都用 sass")).captureRecommended, false);
  } finally {
    noHead.dispose(); off.dispose();
  }
});

test("an explicit save request is remembered for the session: reminded once next turn while the inbox is unchanged, dropped once a candidate appears", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "s1", vaultPath: vault, projectId: "app-12345678" };
  enrichDecision(explicitCapture(), "记住：以后错误码都用 E 开头", turn, {}, options);
  const state = JSON.parse(fs.readFileSync(options.sessionStatePath, "utf8"));
  const entry = state.sessions[sessionIdFor("codex", "s1")];
  assert.equal(entry.capture.kind, "explicit");
  assert.equal(entry.capture.dirs[0], path.join(vault, "20-Projects", "app-12345678", "inbox"));

  // Next turn, nothing staged: one reminder, and the turn is not a compact skip turn.
  const next = enrichDecision(layaDecision(0.05, "skip"), "那把登录页也改一下", turn, {}, { ...options, now: options.now + 60_000 });
  assert.deepEqual(next.captureCarryOver, { text: "记住：以后错误码都用 E 开头" });
  assert.equal(next.memoryAction, "default");
  assert.equal(next.boost, "capture_carry_over");
  assert.match(buildLayaActionNotice(next), /Reminder: last turn the user asked to remember "记住：以后错误码都用 E 开头"/u);
  assert.equal(memoryActionFor(next), "default");

  // Reminded only once.
  const third = enrichDecision(layaDecision(0.05, "skip"), "继续", turn, {}, { ...options, now: options.now + 120_000 });
  assert.equal(third.captureCarryOver, undefined);

  // A new request, then a candidate file appears: no reminder.
  enrichDecision(explicitCapture(), "记一下这个坑", turn, {}, { ...options, now: options.now + 180_000 });
  fs.writeFileSync(path.join(vault, "20-Projects", "app-12345678", "inbox", "cand-1.md"), "# candidate\n");
  const after = enrichDecision(layaDecision(0.05, "skip"), "好的下一步", turn, {}, { ...options, now: options.now + 240_000 });
  assert.equal(after.captureCarryOver, undefined);
});

test("a debugging turn followed by 'it works now' adds a pitfall check", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "s2", vaultPath: vault, projectId: "app-12345678" };
  const revise = { autoCapture: "revise" };
  enrichDecision(layaDecision(0.2, "default"), "为什么模拟器上一直连不上 relay，报错 ECONNREFUSED", turn, revise, options);
  const solved = enrichDecision(layaDecision(0.02, "skip"), "好了，现在可以了", turn, revise, { ...options, now: options.now + 60_000 });
  assert.equal(solved.pitfallCheck, true);
  assert.equal(solved.memoryAction, "default");
  assert.match(buildLayaActionNotice(solved), /previous problem now seems solved/u);
  // A plain next turn after a non-debugging turn does not.
  enrichDecision(layaDecision(0.2, "default"), "把按钮改成蓝色", turn, revise, { ...options, now: options.now + 120_000 });
  const plain = enrichDecision(layaDecision(0.02, "skip"), "好了", turn, revise, { ...options, now: options.now + 180_000 });
  assert.equal(plain.pitfallCheck, undefined);
});

test("pendingCaptureEnforcement fires once for an unstaged explicit request and never after a candidate is written", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "openclaw", sessionKey: "k1", vaultPath: vault, projectId: "app-12345678" };
  assert.equal(pendingCaptureEnforcement({ host: "openclaw", sessionKey: "k1", sessionStatePath: options.sessionStatePath, now: options.now }), null);
  enrichDecision(explicitCapture(), "记住：发版前先跑 npm test", turn, {}, options);
  const pending = pendingCaptureEnforcement({ host: "openclaw", sessionKey: "k1", sessionStatePath: options.sessionStatePath, now: options.now + 5_000 });
  assert.ok(pending);
  assert.match(pending.instruction, /记住：发版前先跑 npm test/u);
  assert.match(pending.instruction, /app-12345678\/inbox/u);
  assert.equal(pendingCaptureEnforcement({ host: "openclaw", sessionKey: "k1", sessionStatePath: options.sessionStatePath, now: options.now + 6_000 }), null, "at most once");

  enrichDecision(explicitCapture(), "记住：另一条", turn, {}, { ...options, now: options.now + 60_000 });
  fs.writeFileSync(path.join(vault, "10-Global", "inbox", "cand-2.md"), "# candidate\n");
  assert.equal(pendingCaptureEnforcement({ host: "openclaw", sessionKey: "k1", sessionStatePath: options.sessionStatePath, now: options.now + 65_000 }), null, "inbox changed");
  // A durable-statement check is advisory: never enforced.
  const durable = { ...explicitCapture(), captureKind: "durable", reason: "durable_statement", trace: { route: "laya", decision: "capture" } };
  enrichDecision(durable, "以后都用 sass", { ...turn, sessionKey: "k2" }, {}, { ...options, now: options.now + 70_000 });
  assert.equal(pendingCaptureEnforcement({ host: "openclaw", sessionKey: "k2", sessionStatePath: options.sessionStatePath, now: options.now + 75_000 }), null);
  assert.equal(inboxSignature([path.join(vault, "missing")]).endsWith(":missing"), true);
});

test("the Codex Stop hook blocks once with the instruction and stays silent when stop_hook_active or nothing is pending", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "sess-9", vaultPath: vault, projectId: "app-12345678" };
  enrichDecision(explicitCapture(), "记住：commit 用中文", turn, {}, options);
  const opts = { sessionStatePath: options.sessionStatePath, now: options.now + 1000 };
  assert.equal(decideStop({ session_id: "sess-9", stop_hook_active: true }, opts), null);
  const out = decideStop({ session_id: "sess-9", stop_hook_active: false }, opts);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /commit 用中文/u);
  assert.equal(decideStop({ session_id: "sess-9" }, opts), null);
  assert.equal(decideStop(null, opts), null);

  // The script itself: garbage on stdin exits 0 with no output.
  const script = path.resolve(__dirname, "..", "scripts", "codex-stop-hook.mjs");
  const res = spawnSync(process.execPath, [script], { input: "not json", encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

test("OpenClaw before_agent_finalize asks for one revision when an explicit request left the inbox untouched", async () => {
  const vault = makeVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-cap-oc-"));
  const statePath = path.join(dir, "session-state.json");
  const registered = [];
  const plugin = createOpenClawPlugin({
    routerFactory: () => ({ evaluateRecall: async () => ({ memoryAction: "default", trace: { route: "laya" } }), dispose() {} })
  });
  plugin.register({
    pluginConfig: { agentConfigs: { main: { vaultPath: vault, cliPath: "obsidian", projectId: "app-12345678" } }, memoryJudge: { mode: "manual", endpoint: "http://127.0.0.1:1" } },
    on: (name, handler) => registered.push({ name, handler }),
    logger: { debug() {}, info() {}, warn() {} }
  });
  const finalize = registered.find((r) => r.name === "before_agent_finalize");
  assert.ok(finalize, "finalize hook registered");
  // Seed the session state the way the prompt hook would.
  const options = { now: Date.now(), env: {}, indexCachePath: path.join(dir, "vault-index.json"), sessionStatePath: statePath, decisionLogPath: path.join(dir, "decisions.jsonl") };
  enrichDecision(explicitCapture(), "记住这个", { host: "openclaw", sessionKey: "oc-1", vaultPath: vault, projectId: "app-12345678" }, {}, options);
  // The hook reads the default session-state path; point it at ours through the env-driven cache dir.
  process.env.OBSIDIAN_MEMORY_LAYA_DIR = dir;
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.copyFileSync(statePath, path.join(dir, "state", "session-state.json"));
  const result = await finalize.handler({ stopHookActive: false, sessionKey: "oc-1" }, { agentId: "main", sessionKey: "oc-1" });
  assert.equal(result?.action, "revise");
  assert.match(result.retry.instruction, /记住这个/u);
  assert.equal(result.retry.maxAttempts, 1);
  assert.equal(await finalize.handler({ stopHookActive: false, sessionKey: "oc-1" }, { agentId: "main", sessionKey: "oc-1" }), undefined, "only once");
});

const LONG_CONCLUSION = "已修复并安装生效。根因是 OpenClaw 2.0 将历史消息身份放进 __openclaw，ClawConnect 没有转换成 Relay 的规范时间线，导致原生端发送的用户消息在到达小程序前就丢失。" +
  "规则改为：只有当前回合确实执行了 send-file 且拿到回执才显示已发送；模型文字不能冒充成功。以后 Hermes 不再通过关键词猜测发送意图。" + "补充说明。".repeat(30);
const LONG_PLAIN = "已按你的要求调整了页面布局，按钮改成蓝色，间距加大，深色模式同步处理。验证通过：npm test 880/880，聊天审计 7/7。请在开发者工具重新编译查看效果。" + "其他细节。".repeat(60);

test("judgeTurnEndCapture fires on a long reply with conclusion words, at most once per turn, and never after the inbox changed", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "te-1", vaultPath: vault, projectId: "app-12345678" };
  const at = (ms) => ({ host: "codex", sessionKey: "te-1", sessionStatePath: options.sessionStatePath, now: options.now + ms });
  const newTurn = (ms, prompt = "为什么小程序收不到消息") => enrichDecision(layaDecision(0.2, "default"), prompt, turn, {}, { ...options, now: options.now + ms });

  // Turn 1: short and plain replies do not fire; a conclusion does, once; a changed reply in the same
  // turn (the continuation after the extra pass) does not fire again.
  newTurn(0);
  assert.ok(conclusionKeywordCount(LONG_CONCLUSION) >= 2);
  assert.equal(judgeTurnEndCapture({ ...at(5_000), assistantText: "短回复。" }), null, "short reply");
  assert.equal(judgeTurnEndCapture({ ...at(5_000), assistantText: LONG_PLAIN }), null, "long but no conclusion words");
  const verdict = judgeTurnEndCapture({ ...at(5_000), assistantText: LONG_CONCLUSION });
  assert.ok(verdict);
  assert.equal(verdict.reason, "turn_end_conclusion_words");
  assert.match(verdict.instruction, /app-12345678\/inbox/u);
  assert.match(verdict.instruction, /If nothing qualifies, finish as you were/u);
  assert.equal(judgeTurnEndCapture({ ...at(6_000), assistantText: LONG_CONCLUSION }), null, "same reply");
  assert.equal(judgeTurnEndCapture({ ...at(7_000), assistantText: LONG_CONCLUSION + " 补跑后又写了一段总结，根因和规则都复述了一遍。" }), null, "changed reply, same turn: locked");

  // Turn 2 (new prompt resets the lock): a plain long reply fires on a high Laya score only.
  newTurn(60_000, "继续");
  assert.equal(judgeTurnEndCapture({ ...at(65_000), assistantText: LONG_PLAIN, layaScore: 0.3 }), null);
  assert.equal(judgeTurnEndCapture({ ...at(66_000), assistantText: LONG_PLAIN + " ", layaScore: 0.6 })?.reason, "turn_end_laya_score");

  // Turn 3: the agent already staged something this turn, nothing to ask.
  newTurn(120_000, "再看看");
  fs.writeFileSync(path.join(vault, "20-Projects", "app-12345678", "inbox", "cand-te.md"), "# c\n");
  assert.equal(judgeTurnEndCapture({ ...at(125_000), assistantText: LONG_CONCLUSION }), null);

  // Turn 4: off.
  newTurn(180_000, "下一个");
  assert.equal(judgeTurnEndCapture({ ...at(185_000), mode: "off", assistantText: LONG_CONCLUSION }), null);
});

test("turnEndNeedsScore asks for the local model only when the cheap features cannot decide", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "ns-1", vaultPath: vault, projectId: "app-12345678" };
  const at = (ms, extra = {}) => ({ host: "codex", sessionKey: "ns-1", sessionStatePath: options.sessionStatePath, now: options.now + ms, ...extra });
  enrichDecision(layaDecision(0.2, "default"), "看看这个页面", turn, {}, options);
  assert.equal(turnEndNeedsScore(at(1_000, { assistantText: "短回复。" })), false, "short");
  assert.equal(turnEndNeedsScore(at(1_000, { assistantText: LONG_CONCLUSION })), false, "enough conclusion words: fires without a score");
  assert.equal(turnEndNeedsScore(at(1_000, { assistantText: LONG_PLAIN })), true, "long, few words: needs the score");
  assert.equal(turnEndNeedsScore(at(1_000, { assistantText: LONG_PLAIN, mode: "off" })), false, "off");
  assert.equal(turnEndNeedsScore({ ...at(1_000, { assistantText: LONG_PLAIN }), sessionKey: "unknown" }), false, "no session state");
  // Already fired this turn.
  judgeTurnEndCapture(at(2_000, { assistantText: LONG_CONCLUSION }));
  assert.equal(turnEndNeedsScore(at(3_000, { assistantText: LONG_PLAIN })), false, "turn already revised");
  // New turn, inbox changed during it.
  enrichDecision(layaDecision(0.2, "default"), "继续", turn, {}, { ...options, now: options.now + 60_000 });
  fs.writeFileSync(path.join(vault, "20-Projects", "app-12345678", "inbox", "cand-ns.md"), "# c\n");
  assert.equal(turnEndNeedsScore(at(61_000, { assistantText: LONG_PLAIN })), false, "inbox changed");
  // New turn with an explicit request still due: that pass comes first.
  enrichDecision(explicitCapture(), "记住：以后都用 sass", turn, {}, { ...options, now: options.now + 120_000 });
  assert.equal(turnEndNeedsScore(at(121_000, { assistantText: LONG_PLAIN })), false, "explicit request pending");
});

test("the explicit-request pass and the end-of-turn pass share one extra pass per turn", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "one-1", vaultPath: vault, projectId: "app-12345678" };
  enrichDecision(explicitCapture(), "记住：发版前先跑 npm test", turn, {}, options);
  const opts = { host: "codex", sessionKey: "one-1", sessionStatePath: options.sessionStatePath, now: options.now + 1_000 };
  assert.ok(pendingCaptureEnforcement(opts), "explicit pass first");
  assert.equal(judgeTurnEndCapture({ ...opts, now: options.now + 2_000, assistantText: LONG_CONCLUSION }), null, "no second pass in the same turn");
});

test("without a resolved project nothing is steered into Global, and a candidate in any project inbox counts as staged", () => {
  const vault = makeVault();
  fs.mkdirSync(path.join(vault, "20-Projects", "other-87654321", "inbox"), { recursive: true });
  const options = ctx();
  // No projectId and a cwd that projects.yaml does not know.
  const turn = { host: "codex", sessionKey: "np-1", vaultPath: vault, cwd: "/somewhere/else" };
  const scope = inboxScope(vault, null);
  assert.equal(scope.target, null);
  assert.ok(scope.dirs.includes(path.join(vault, "10-Global", "inbox")));
  assert.ok(scope.dirs.includes(path.join(vault, "20-Projects", "app-12345678", "inbox")));
  assert.ok(scope.dirs.includes(path.join(vault, "20-Projects", "other-87654321", "inbox")));
  assert.equal(inboxScope(vault, "app-12345678").target, path.join(vault, "20-Projects", "app-12345678", "inbox"));

  enrichDecision(layaDecision(0.2, "default"), "排查一下消息丢失", turn, {}, options);
  const verdict = judgeTurnEndCapture({ host: "codex", sessionKey: "np-1", sessionStatePath: options.sessionStatePath, now: options.now + 1_000, assistantText: LONG_CONCLUSION });
  assert.ok(verdict);
  assert.ok(!verdict.instruction.includes(path.join(vault, "10-Global", "inbox")), "Global is not the named target");
  assert.match(verdict.instruction, /scope the obsidian-memory skill resolves/u);

  // Explicit request without a project: the agent writes into a project inbox the skill resolved.
  const t2 = { ...turn, sessionKey: "np-2" };
  enrichDecision(explicitCapture(), "记住：日志统一用 JSON", t2, {}, options);
  fs.writeFileSync(path.join(vault, "20-Projects", "other-87654321", "inbox", "cand-np.md"), "# c\n");
  assert.equal(pendingCaptureEnforcement({ host: "codex", sessionKey: "np-2", sessionStatePath: options.sessionStatePath, now: options.now + 2_000 }), null, "write detected: no re-ask");
  // And when nothing was written, the instruction does not name Global either.
  const t3 = { ...turn, sessionKey: "np-3" };
  enrichDecision(explicitCapture(), "记住：commit 用中文", t3, {}, { ...options, now: options.now + 3_000 });
  const pending = pendingCaptureEnforcement({ host: "codex", sessionKey: "np-3", sessionStatePath: options.sessionStatePath, now: options.now + 4_000 });
  assert.ok(pending);
  assert.ok(!pending.instruction.includes(path.join(vault, "10-Global", "inbox")));
  assert.match(pending.instruction, /any Vault inbox/u);
});

test("remind mode carries the end-of-turn verdict into the next turn's hint instead of a revision", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "te-2", vaultPath: vault, projectId: "app-12345678" };
  enrichDecision(layaDecision(0.2, "default"), "排查一下消息丢失", turn, {}, options);
  const verdict = judgeTurnEndCapture({ host: "codex", sessionKey: "te-2", sessionStatePath: options.sessionStatePath, now: options.now + 5_000, assistantText: LONG_CONCLUSION, mode: "remind" });
  assert.ok(verdict, "the verdict is still computed and recorded");
  const next = enrichDecision(layaDecision(0.05, "skip"), "好的继续", turn, {}, { ...options, now: options.now + 60_000 });
  assert.equal(next.turnEndReminder, true);
  assert.equal(next.memoryAction, "default");
  assert.match(buildLayaActionNotice(next), /previous reply looked like it held a durable conclusion/u);
  const later = enrichDecision(layaDecision(0.05, "skip"), "再来", turn, {}, { ...options, now: options.now + 120_000 });
  assert.equal(later.turnEndReminder, undefined, "reminded once");
});

test("the Codex Stop hook reads the final reply from the payload or the transcript and asks for a capture pass", () => {
  const vault = makeVault();
  const options = ctx();
  const turn = { host: "codex", sessionKey: "sess-te", vaultPath: vault, projectId: "app-12345678" };
  enrichDecision(layaDecision(0.2, "default"), "排查一下", turn, {}, options);
  const opts = { sessionStatePath: options.sessionStatePath, now: options.now + 1000, config: parseMemoryJudgeConfig({ mode: "auto", autoCapture: "revise" }) };
  const out = decideStop({ session_id: "sess-te", last_assistant_message: LONG_CONCLUSION }, opts);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /end-of-turn check \(this overrides any earlier "memory not needed" hint/u);
  assert.match(out.reason, /such a pitfall counts/u);
  assert.equal(decideStop({ session_id: "sess-te", last_assistant_message: LONG_CONCLUSION }, opts), null, "once per reply");
  // Transcript parsing: the task_complete event wins, else the last assistant message.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-transcript-"));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "中间回复" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: LONG_CONCLUSION + " 尾巴" } })
  ].join("\n") + "\n");
  assert.equal(lastAssistantMessageFromTranscript(file), LONG_CONCLUSION + " 尾巴");
  assert.equal(lastAssistantMessageFromTranscript(path.join(dir, "missing.jsonl")), null);
  assert.equal(decideStop({ session_id: "sess-te", transcript_path: file }, opts), null, "same turn: already revised");
  enrichDecision(layaDecision(0.2, "default"), "继续", turn, {}, { ...options, now: options.now + 60_000 });
  const viaTranscript = decideStop({ session_id: "sess-te", transcript_path: file }, { ...opts, now: options.now + 61_000 });
  assert.equal(viaTranscript?.decision, "block");
  // autoCapture off or remind: no block.
  assert.equal(decideStop({ session_id: "sess-te", last_assistant_message: LONG_CONCLUSION + " x" }, { ...opts, config: parseMemoryJudgeConfig({ mode: "auto", autoCapture: "off" }) }), null);
  assert.equal(decideStop({ session_id: "sess-te", last_assistant_message: LONG_CONCLUSION + " y" }, { ...opts, config: parseMemoryJudgeConfig({ mode: "auto", autoCapture: "remind" }) }), null);
  assert.equal(judgeConfigFromEnv({ OBSIDIAN_MEMORY_AUTO_CAPTURE: "remind" }).autoCapture, "remind");
  assert.equal(judgeConfigFromEnv({}).autoCapture, "digest");
});

test("OpenClaw before_agent_finalize runs the end-of-turn check on lastAssistantMessage with the router's capture score", async () => {
  const vault = makeVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-te-oc-"));
  process.env.OBSIDIAN_MEMORY_LAYA_DIR = dir;
  const registered = [];
  let scoreCalls = 0;
  const plugin = createOpenClawPlugin({
    routerFactory: () => ({ evaluateRecall: async () => ({ memoryAction: "default", trace: { route: "laya" } }), captureScoreFor: async () => { scoreCalls++; return 0.9; }, dispose() {} })
  });
  plugin.register({
    pluginConfig: { agentConfigs: { main: { vaultPath: vault, cliPath: "obsidian", projectId: "app-12345678" } }, memoryJudge: { mode: "manual", endpoint: "http://127.0.0.1:1", autoCapture: "revise" } },
    on: (name, handler) => registered.push({ name, handler }),
    logger: { debug() {}, info() {}, warn() {} }
  });
  const finalize = registered.find((r) => r.name === "before_agent_finalize").handler;
  const statePath = path.join(dir, "state", "session-state.json");
  enrichDecision(layaDecision(0.2, "default"), "排查一下", { host: "openclaw", vaultPath: vault, projectId: "app-12345678", sessionKey: "oc-te" }, {}, { now: Date.now(), env: {}, indexCachePath: path.join(dir, "vi.json"), sessionStatePath: statePath, decisionLogPath: path.join(dir, "d.jsonl") });
  const seed = (key) => enrichDecision(layaDecision(0.2, "default"), "排查一下", { host: "openclaw", vaultPath: vault, projectId: "app-12345678", sessionKey: key }, {}, { now: Date.now(), env: {}, indexCachePath: path.join(dir, "vi.json"), sessionStatePath: statePath, decisionLogPath: path.join(dir, "d.jsonl") });
  const result = await finalize({ stopHookActive: false, sessionKey: "oc-te", lastAssistantMessage: LONG_PLAIN }, { agentId: "main", sessionKey: "oc-te" });
  assert.equal(scoreCalls, 1, "plain long reply: the model is asked");
  assert.equal(result?.action, "revise", "plain long reply + high Laya score");
  assert.equal(result.reason, "obsidian_memory_turn_end_capture");
  assert.equal(await finalize({ stopHookActive: false, sessionKey: "oc-te", lastAssistantMessage: LONG_CONCLUSION }, { agentId: "main", sessionKey: "oc-te" }), undefined, "same turn: locked");
  assert.equal(scoreCalls, 1);
  seed("oc-te2");
  const words = await finalize({ stopHookActive: false, sessionKey: "oc-te2", lastAssistantMessage: LONG_CONCLUSION }, { agentId: "main", sessionKey: "oc-te2" });
  assert.equal(words?.action, "revise");
  assert.equal(scoreCalls, 1, "conclusion words decide alone: no model call");
  seed("oc-te3");
  assert.equal(await finalize({ stopHookActive: false, sessionKey: "oc-te3", lastAssistantMessage: "短。" }, { agentId: "main", sessionKey: "oc-te3" }), undefined);
  assert.equal(scoreCalls, 1, "short reply: no model call");
});

test("a concise real Codex pitfall reply (cause + fix, about 280 characters) triggers the end-of-turn check", () => {
  // Final reply of an isolated real Codex turn (2026-09-25); the first word list and the 300-character gate missed it.
  const reply = "已修复 [setup.mjs](/tmp/demo-app/setup.mjs:4)。\n\n原因：`existsSync` 会跟随软链接，失效链接返回 `false`，导致跳过删除；链接本身仍占用目标路径，因此创建时报 `EEXIST`。\n\n" +
    "修法：去掉存在性判断，直接调用带 `force: true` 的 `rmSync`，它会删除失效链接本身而不跟随目标；目标不存在时也不会报错。已用失效链接、正常文件和空路径三种情况验证，行为符合预期，没有改动其他文件。";
  assert.ok(reply.length >= 200 && reply.length < 300, `reply length ${reply.length}`);
  assert.ok(conclusionKeywordCount(reply) >= 2);
  const vault = makeVault();
  const options = ctx();
  enrichDecision(layaDecision(0.05, "skip"), "setup.mjs 在目标路径是失效软链接时报 EEXIST，找出根因并修好", { host: "codex", sessionKey: "real-1", vaultPath: vault, projectId: "app-12345678" }, {}, options);
  const verdict = judgeTurnEndCapture({ host: "codex", sessionKey: "real-1", sessionStatePath: options.sessionStatePath, now: options.now + 1_000, assistantText: reply });
  assert.equal(verdict?.reason, "turn_end_conclusion_words");
});
