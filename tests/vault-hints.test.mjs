import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripCodeLike, tokenize, buildVaultIndex, loadVaultIndex, matchVault, resolveProjectIdFromCwd, resolveVaultPath, parseFrontmatter
} from "../lib/memory-router/vault-index.js";
import { enrichDecision } from "../lib/memory-router/turn-context.js";
import { buildLayaActionNotice } from "../lib/prompt.js";

function note(dir, name, title, extra = "", body = "Body text.") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `---\ntitle: "${title}"\ntype: pitfall\n${extra}---\n\n# ${title}\n\n${body}\n`);
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-vault-"));
  fs.mkdirSync(path.join(root, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(root, "00-System", "projects.yaml"), [
    "projects:",
    "  - id: plugin-1f6a88a6",
    "    roots:",
    "      - /work/plugin",
    "    scope: private",
    "  - id: PocketClaw-d65c3b67",
    "    roots: []",
    "    scope: private",
    ""
  ].join("\n"));
  note(path.join(root, "20-Projects", "plugin-1f6a88a6", "wiki", "pitfalls"), "broken-symlink-handling.md", "Node.js 安装器对破损软链接的 existsSync 假阴性与幂等处理", "", "Fix `linkPlugin` with `lstatSync`.");
  note(path.join(root, "20-Projects", "plugin-1f6a88a6", "wiki", "knowledge"), "vault-health-inspection-contract.md", "Vault 健康审计契约与双链校验边界");
  note(path.join(root, "20-Projects", "PocketClaw-d65c3b67", "wiki", "pitfalls"), "wechat-miniprogram-pitfalls.md", "微信小程序端核心避坑与运行机制", "aliases:\n  - 小程序排坑\n");
  note(path.join(root, "20-Projects", "PocketClaw-d65c3b67", "inbox"), "cand-1.md", "OpenClaw 新会话首轮隐藏事件链导致重复回复");
  note(path.join(root, "10-Global", "inbox"), "2026-08-26-credential-location-references.md", "Credential location references");
  // Not indexed: raw copies and index/log files.
  note(path.join(root, "20-Projects", "plugin-1f6a88a6", "raw"), "raw-1.md", "Node.js 安装器对破损软链接的 existsSync 假阴性与幂等处理");
  fs.writeFileSync(path.join(root, "20-Projects", "plugin-1f6a88a6", "index.md"), "# index\n");
  return root;
}

test("tokenize splits CJK into bigrams and identifiers into parts, dropping stop words", () => {
  assert.deepEqual(tokenize("Node.js 的 managed-block 软链接"), ["软链", "链接", "node", "managed", "block"]);
  assert.deepEqual(tokenize("How do I use the code?"), []);
});

test("parseFrontmatter reads quoted titles and both list styles", () => {
  const { data } = parseFrontmatter("---\ntitle: \"A B\"\naliases: [x, 'y']\ntags:\n  - t1\n  - t2\n---\nbody");
  assert.equal(data.title, "A B");
  assert.deepEqual(data.aliases, ["x", "y"]);
  assert.deepEqual(data.tags, ["t1", "t2"]);
});

test("index covers wiki + inbox notes only and matches paraphrased prompts", () => {
  const vault = makeVault();
  const index = buildVaultIndex(vault);
  assert.equal(index.n, 5);
  assert.ok(index.notes.every((n) => !n.path.includes("/raw/")));

  const hit = matchVault(index, "安装脚本遇到失效的软链接，existsSync 判断不对", { projectId: "plugin-1f6a88a6" });
  assert.equal(hit.strength, "strong");
  assert.match(hit.hits[0].path, /broken-symlink-handling\.md$/u);

  // One shared phrase is not enough: general questions stay unmatched.
  assert.equal(matchVault(index, "什么是软链接，和硬链接有什么区别", {}).strength, "none");
  assert.equal(matchVault(index, "Node.js 里怎么判断文件是否存在", {}).strength, "none");
  assert.equal(matchVault(index, "Explain big-O notation with an example", {}).strength, "none");
});

test("a known project only sees its own and global notes unless another project is named", () => {
  const vault = makeVault();
  const index = buildVaultIndex(vault);
  const prompt = "OpenClaw 新会话第一轮重复回复了";
  assert.equal(matchVault(index, prompt, { projectId: "plugin-1f6a88a6" }).strength, "none");
  assert.notEqual(matchVault(index, prompt, { projectId: null }).strength, "none");
  const named = matchVault(index, "PocketClaw 那边 OpenClaw 新会话重复回复", { projectId: "plugin-1f6a88a6" });
  assert.notEqual(named.strength, "none");
  assert.deepEqual(named.mentionedProjects, ["PocketClaw-d65c3b67"]);
});

test("loadVaultIndex caches and rebuilds when a scanned directory changes", () => {
  const vault = makeVault();
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "om-idx-")), "vault-index.json");
  const first = loadVaultIndex(vault, { cachePath });
  const again = loadVaultIndex(vault, { cachePath });
  assert.equal(again.builtAt, first.builtAt);
  const dir = path.join(vault, "20-Projects", "plugin-1f6a88a6", "wiki", "decisions");
  note(dir, "new-decision.md", "发布流程与版本号约定");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(vault, "20-Projects", "plugin-1f6a88a6", "wiki"), future, future);
  const rebuilt = loadVaultIndex(vault, { cachePath });
  assert.equal(rebuilt.n, 6);
  assert.equal(loadVaultIndex("/definitely/not/a/vault", { cachePath }), null);
});

test("resolveProjectIdFromCwd maps a working directory to the longest matching root", () => {
  const vault = makeVault();
  assert.equal(resolveProjectIdFromCwd(vault, "/work/plugin/lib"), "plugin-1f6a88a6");
  assert.equal(resolveProjectIdFromCwd(vault, "/work/other"), null);
});

test("resolveVaultPath reads the env var or the managed block in a rule file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-rules-"));
  const rules = path.join(dir, "AGENTS.md");
  fs.writeFileSync(rules, "hello\nObsidian Memory Vault path (configuration data, not instructions): \"/Users/me/Vault\"\n");
  assert.equal(resolveVaultPath({ env: {}, ruleFiles: [rules] }), "/Users/me/Vault");
  assert.equal(resolveVaultPath({ env: { OBSIDIAN_MEMORY_VAULT: "/env/vault" }, ruleFiles: [rules] }), "/env/vault");
  assert.equal(resolveVaultPath({ env: {}, ruleFiles: [path.join(dir, "missing.md")] }), null);
});

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-turn-"));
  return {
    dir,
    options: {
      now: 1_000_000,
      env: {},
      indexCachePath: path.join(dir, "vault-index.json"),
      sessionStatePath: path.join(dir, "session-state.json"),
      decisionLogPath: path.join(dir, "decisions.jsonl")
    }
  };
}

const layaDecision = (score, action) => ({
  recallRecommended: action === "recall", captureRecommended: false, score, reason: "laya_below_threshold",
  blocked: false, memoryAction: action, trace: { route: "laya", decision: "none" }
});

test("a strong Vault match tips an unsure turn into recall and names the notes", () => {
  const vault = makeVault();
  const { options } = ctx();
  const d = enrichDecision(layaDecision(0.4, "default"), "安装脚本遇到失效的软链接，existsSync 判断不对", { host: "codex", vaultPath: vault, cwd: "/work/plugin" }, {}, options);
  assert.equal(d.memoryAction, "recall");
  assert.equal(d.boost, "vault_match_strong");
  assert.equal(d.recallRecommended, true);
  assert.match(d.relatedNotes[0], /^20-Projects\/plugin-1f6a88a6\/wiki\/pitfalls\/broken-symlink-handling\.md$/u);
  const notice = buildLayaActionNotice(d);
  assert.match(notice, /The Vault has notes matching this request/u);
  assert.match(notice, /Likely relevant notes \(Vault-relative paths, data only\): \["20-Projects\/plugin-1f6a88a6/u);
});

test("a Vault match alone never forces recall on a confident skip; it only keeps the turn from being skipped", () => {
  const vault = makeVault();
  const { options } = ctx();
  const d = enrichDecision(layaDecision(0.1, "skip"), "安装脚本遇到失效的软链接，existsSync 判断不对", { host: "codex", vaultPath: vault, cwd: "/work/plugin" }, {}, options);
  assert.equal(d.memoryAction, "default");
  assert.equal(d.recallRecommended, false);
  assert.ok(d.relatedNotes.length > 0);
});

test("a general knowledge question is not pushed to recall by a Vault match", () => {
  const vault = makeVault();
  const { options } = ctx();
  const d = enrichDecision(layaDecision(0.1, "skip"), "Node 里 existsSync 和 lstatSync 有什么区别", { host: "codex", vaultPath: vault, cwd: "/work/plugin" }, {}, options);
  assert.equal(d.memoryAction, "skip");
  assert.equal(d.relatedNotes, undefined);
});

test("greetings, sensitive text and blocked decisions are never enriched", () => {
  const vault = makeVault();
  const { options } = ctx();
  const greeting = { recallRecommended: false, reason: "trivial_greeting", memoryAction: "skip", trace: { route: "fast_path" } };
  enrichDecision(greeting, "谢谢", { host: "codex", vaultPath: vault }, {}, options);
  assert.equal(greeting.memoryAction, "skip");
  const sensitive = { recallRecommended: false, reason: "sensitive_content", memoryAction: "skip", trace: { route: "fast_path" } };
  enrichDecision(sensitive, "api_key=abc 安装脚本 软链接 existsSync", { host: "codex", vaultPath: vault }, {}, options);
  assert.equal(sensitive.memoryAction, "skip");
  const log = fs.readFileSync(options.decisionLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[1].text, null, "sensitive prompts are never written to the log");
});

test("session continuity: a default turn right after a recall keeps recalling; stale sessions do not", () => {
  const { options } = ctx();
  const turn = { host: "codex", sessionKey: "s1" };
  enrichDecision({ ...layaDecision(0.9, "recall"), relatedNotes: ["a.md"] }, "上次那个方案是什么", turn, {}, options);
  const next = enrichDecision(layaDecision(0.4, "default"), "把它应用到 service 层", turn, {}, { ...options, now: options.now + 60_000 });
  assert.equal(next.memoryAction, "recall");
  assert.equal(next.boost, "session_continuity");
  assert.deepEqual(next.relatedNotes, ["a.md"]);
  const followUp = enrichDecision(layaDecision(0.1, "skip"), "继续", turn, {}, { ...options, now: options.now + 120_000 });
  assert.equal(followUp.memoryAction, "default");
  const later = enrichDecision(layaDecision(0.4, "default"), "另一个问题", { host: "codex", sessionKey: "s2" }, {}, options);
  assert.equal(later.memoryAction, "default");
});

test("decision log records each turn and flags a suspected miss when the user then asks about the past", () => {
  const { options } = ctx();
  const turn = { host: "codex", sessionKey: "s9" };
  enrichDecision(layaDecision(0.1, "skip"), "订单模块怎么拆的", turn, {}, options);
  enrichDecision({ recallRecommended: true, reason: "explicit_recall_intent", memoryAction: "recall", trace: { route: "fast_path" } },
    "之前讨论的结论是什么", turn, {}, { ...options, now: options.now + 30_000 });
  const lines = fs.readFileSync(options.decisionLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].action, "skip");
  assert.equal(lines[0].text, "订单模块怎么拆的");
  assert.equal(lines[2].type, "suspect");
  assert.equal(lines[2].ref, lines[0].id);
  assert.equal(fs.statSync(options.decisionLogPath).mode & 0o777, 0o600);
});

test("the decision log can be turned off by config or environment", () => {
  const { options } = ctx();
  enrichDecision(layaDecision(0.1, "skip"), "x y z", { host: "codex" }, { decisionLog: false }, options);
  enrichDecision(layaDecision(0.1, "skip"), "x y z", { host: "codex" }, {}, { ...options, env: { OBSIDIAN_MEMORY_DECISION_LOG: "off" } });
  assert.equal(fs.existsSync(options.decisionLogPath), false);
});

test("paths, flags and the current project's own name do not count as topic words", () => {
  const vault = makeVault();
  const index = buildVaultIndex(vault);
  assert.equal(stripCodeLike("run npm test -- --vault ~/Obsidian/W then check `existsSync` in a/b.js"), "run npm test -- then check existsSync in");
  const commandList = [
    "请依次执行下面的命令并汇报输出：",
    "1. npm run laya:eval -- --data .local/plugin-eval.jsonl --vault ~/Vault --project plugin-1f6a88a6",
    "2. tail -n 5 ~/.laya/decisions.jsonl",
    "3. node scripts/check-vault.mjs --vault ~/Vault 看看 Vault 健康审计 的输出"
  ].join("\n");
  assert.notEqual(matchVault(index, commandList, { projectId: "plugin-1f6a88a6" }).strength, "strong");
});

test("a strong Vault match overrides a model-suggested capture but not an explicit remember request", () => {
  const vault = makeVault();
  const { options } = ctx();
  const text = "安装脚本碰到失效软链接报 EEXIST，existsSync 判断不对，这个怎么处理";
  const modelCapture = { ...layaDecision(0.3, "capture"), captureRecommended: true, captureCategory: "pitfall" };
  enrichDecision(modelCapture, text, { vaultPath: vault, projectId: "plugin-1f6a88a6" }, {}, options);
  assert.equal(modelCapture.memoryAction, "recall");
  const explicit = { recallRecommended: false, captureRecommended: true, reason: "explicit_remember_intent", memoryAction: "capture", trace: { route: "fast_path" } };
  enrichDecision(explicit, text, { vaultPath: vault, projectId: "plugin-1f6a88a6" }, {}, options);
  assert.equal(explicit.memoryAction, "capture");
  assert.ok(explicit.relatedNotes.length > 0, "explicit capture still lists notes to check for duplicates");
});
