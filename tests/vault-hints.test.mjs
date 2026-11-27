// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripCodeLike, tokenize, buildVaultIndex, loadVaultIndex, matchVault, noteTopicText, noteEmbedChunks, allocateIndexSlots,
  resolveProjectIdFromCwd, resolveVaultPath, parseFrontmatter
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
  if (process.platform !== "win32") assert.equal(fs.statSync(options.decisionLogPath).mode & 0o777, 0o600);
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

test("resolveProjectIdFromCwd matches a cwd reported through a symlinked path", () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "om-link-vault-"));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "om-link-real-"));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "om-link-")), "proj");
  fs.symlinkSync(real, link);
  fs.mkdirSync(path.join(vault, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(vault, "00-System", "projects.yaml"), `projects:\n  - id: linked-11111111\n    roots:\n      - ${link}\n`);
  assert.equal(resolveProjectIdFromCwd(vault, link), "linked-11111111");
  assert.equal(resolveProjectIdFromCwd(vault, fs.realpathSync(real)), "linked-11111111", "physical path of the registered symlink");
  assert.equal(resolveProjectIdFromCwd(vault, path.join(fs.realpathSync(real), "src")), "linked-11111111");
  assert.equal(resolveProjectIdFromCwd(vault, os.tmpdir()), null);
});

test("index skips inactive inbox notes and sub-index files, extracts ## headings, and invalidates on in-place file edits", () => {
  const vault = makeVault();
  const projDir = path.join(vault, "20-Projects", "plugin-1f6a88a6");
  // Inactive inbox candidates (ingested / discarded) and split navigation indexes must not enter the index.
  note(path.join(projDir, "inbox"), "cand-done.md", "已入库候选不应占索引名额", "status: ingested\n");
  note(path.join(projDir, "inbox"), "cand-drop.md", "已丢弃候选不应占索引名额", "status: discarded\n");
  note(path.join(projDir, "wiki"), "index-portal.md", "模块子索引不应被检索", "");
  note(path.join(projDir, "raw"), "raw-index.md", "Raw 子索引", "");
  // Long multi-section manual: section 4 lives far beyond 600 chars.
  const filler = "这里是前置常规巡检步骤的详细说明文字，用于模拟真实长篇运维手册的前半部分内容。".repeat(12);
  const longManual = [
    "---",
    'title: "门户后台综合操作手册"',
    "type: knowledge",
    "status: active",
    "deprecated: false",
    "---",
    "",
    "# 门户后台综合操作手册",
    "",
    "## 一、基础登录与巡检",
    filler,
    "## 二、组织架构刷新",
    filler,
    "## 三、兼职信息维护",
    "在组织人员管理中打开员工兼职信息维护页签并提交审批。"
  ].join("\n");
  fs.mkdirSync(path.join(projDir, "wiki", "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "wiki", "knowledge", "portal-manual.md"), longManual);

  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "om-idx-stat-")), "vault-index.json");
  const idx = loadVaultIndex(vault, { cachePath });
  assert.ok(!idx.notes.some((n) => /cand-done|cand-drop|index-portal|raw-index/.test(n.path)));
  const manualEntry = idx.notes.find((n) => n.path.endsWith("portal-manual.md"));
  assert.ok(manualEntry);
  assert.ok(manualEntry.embedChunks.length >= 2, "long multi-section manual produces multiple chunks");

  const lateHit = matchVault(idx, "员工兼职信息维护页签怎么操作", { projectId: "plugin-1f6a88a6" });
  assert.notEqual(lateHit.strength, "none");
  assert.match(lateHit.hits[0].path, /portal-manual\.md$/u);

  // In-place edit (toggling deprecated: true without adding/removing files) invalidates cache immediately.
  const updatedManual = longManual.replace("deprecated: false", "deprecated: true");
  const manualFile = path.join(projDir, "wiki", "knowledge", "portal-manual.md");
  fs.writeFileSync(manualFile, updatedManual);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(manualFile, future, future);
  const rebuilt = loadVaultIndex(vault, { cachePath });
  assert.equal(rebuilt.notes.find((n) => n.path.endsWith("portal-manual.md")).deprecated, true);
});

test("notes with large pasted code blocks + comments keep prose symbols and fold code boilerplate in embeddings", () => {
  const fillerVars = Array.from({ length: 45 }, (_, i) => `const dummyBoilerplateVar${i} = ${i};`).join("\n");
  const content = [
    "---",
    'title: "网关重试机制与自定义退避"',
    "type: knowledge",
    "---",
    "",
    "# 网关重试机制与自定义退避",
    "",
    "## 核心代码与注释",
    "",
    "当遇到网关限流时使用 `retryWithJitter` 执行指数退避：",
    "",
    "```js",
    "// 关键约束：仅对幂等 GET 请求启用指数退避，防止重复扣款",
    fillerVars,
    "```",
    "",
    "注意调用方必须传入 `idempotencyKey`。"
  ].join("\n");
  const topic = noteTopicText("/v/wiki/knowledge/retry.md", content);
  assert.match(topic, /retryWithJitter/u);
  assert.match(topic, /idempotencyKey/u);
  const chunks = noteEmbedChunks("/v/wiki/knowledge/retry.md", content);
  assert.match(chunks[0], /仅对幂等 GET 请求启用指数退避/u);
  assert.doesNotMatch(chunks[0], /dummyBoilerplateVar20/u);
});

test("short code blocks are embedded as written, trailing # comments are kept, and an uncommented large block leaves its opening", () => {
  const note = (code) => ["---", 'title: "事务回滚"', "---", "", "# 事务回滚", "", "出错时必须回滚：", "", "```python", code, "```", ""].join("\n");
  // A short fix pattern (8 lines, no comment line of its own) stays in the vector.
  const small = noteEmbedChunks("/v/wiki/pitfalls/tx.md", note('conn.execute("BEGIN")\ntry:\n    ...  # 业务读取与统计\n    conn.execute("COMMIT")\n    return result\nexcept Exception:\n    conn.execute("ROLLBACK")\n    raise'));
  assert.match(small[0], /ROLLBACK/u);
  assert.match(small[0], /业务读取与统计/u);

  // A large block: whole-line and trailing comments both make the summary; "#include" is not a comment.
  const filler = Array.from({ length: 30 }, (_, i) => `x${i} = ${i}`).join("\n");
  const commented = noteEmbedChunks("/v/wiki/pitfalls/tx.md", note(`#include <stdio.h>\n# 整行注释：先开事务\n${filler}\nconn.commit()  # 行尾注释：最后提交`));
  assert.match(commented[0], /\[code comments: 整行注释：先开事务; 行尾注释：最后提交\]/u);
  assert.doesNotMatch(commented[0], /include <stdio/u);

  // A large block without any comment keeps its opening instead of vanishing.
  const bare = noteEmbedChunks("/v/wiki/pitfalls/tx.md", note(`conn.execute("BEGIN")\n${filler}`));
  assert.match(bare[0], /\[code: conn\.execute\("BEGIN"\)/u);
  assert.doesNotMatch(bare[0], /x29 = 29/u);
});

test("deprecated notes are skipped by default, deprioritized on slot truncation, and returned as fallback on explicit recall", () => {
  const vault = makeVault();
  const projDir = path.join(vault, "20-Projects", "plugin-1f6a88a6");
  note(path.join(projDir, "wiki", "knowledge"), "old-menu.md", "旧版公文分发菜单操作指南", "deprecated: true\n", "旧版公文分发入口在系统菜单。");
  const idx = buildVaultIndex(vault);

  assert.equal(matchVault(idx, "旧版公文分发菜单怎么操作", { projectId: "plugin-1f6a88a6" }).strength, "none");
  const withDep = matchVault(idx, "旧版公文分发菜单怎么操作", { projectId: "plugin-1f6a88a6", includeDeprecated: true });
  assert.notEqual(withDep.strength, "none");
  assert.equal(withDep.hits[0].deprecated, true);

  // Explicit recall falls back to deprecated note and surfaces deprecation warning in prompt notice.
  const { options } = ctx();
  const explicit = {
    recallRecommended: true, captureRecommended: false, reason: "explicit_recall_intent",
    memoryAction: "recall", scope: "project", trace: { route: "fast_path", decision: "recall" }
  };
  enrichDecision(explicit, "回忆一下旧版公文分发菜单怎么操作", { host: "codex", vaultPath: vault, projectId: "plugin-1f6a88a6" }, {}, { ...options, vaultIndex: idx });
  assert.ok(explicit.deprecatedNotes.some((p) => p.endsWith("old-menu.md")));
  assert.match(buildLayaActionNotice(explicit), /marked deprecated/u);

  // Truncation keeps active notes ahead of deprecated ones even if deprecated has newer mtime.
  const { chosen } = allocateIndexSlots([
    { projectId: "p1", file: "/a/dep.md", mtimeMs: 2000, deprecated: true },
    { projectId: "p1", file: "/a/active.md", mtimeMs: 1000, deprecated: false }
  ], 1);
  assert.equal(chosen.has("/a/active.md"), true);
  assert.equal(chosen.has("/a/dep.md"), false);
});

test("buildVaultIndex keeps wiki/archive/ notes and index-* notes below the wiki root, and skips only root sub-indexes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-idx-nav-"));
  try {
    const wiki = path.join(root, "20-Projects", "demo-12345678", "wiki");
    fs.mkdirSync(path.join(wiki, "archive"), { recursive: true });
    fs.mkdirSync(path.join(wiki, "knowledge"), { recursive: true });
    fs.writeFileSync(path.join(wiki, "index-portal.md"), "# Portal sub-index\n- [[a]]\n");
    fs.writeFileSync(path.join(wiki, "archive", "old-scheme.md"), "---\ntitle: 旧方案\n---\n\n# 旧方案\n");
    fs.writeFileSync(path.join(wiki, "knowledge", "index-rebuild.md"), "---\ntitle: 索引重建踩坑\n---\n\n# 索引重建\n");
    const paths = buildVaultIndex(root).notes.map((n) => n.path).sort();
    assert.deepEqual(paths, [
      "20-Projects/demo-12345678/wiki/archive/old-scheme.md",
      "20-Projects/demo-12345678/wiki/knowledge/index-rebuild.md"
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an index rebuild re-reads only notes whose mtime or size changed", () => {
  const vault = makeVault();
  const first = buildVaultIndex(vault);
  assert.ok(first.fileMeta && Object.keys(first.fileMeta).length >= first.n);
  // Mark every note of the previous index: a reused note keeps the mark, a re-read one does not.
  const previous = { ...first, notes: first.notes.map((n) => ({ ...n, terms: { ...n.terms, reusedmark: 1 } })) };
  const edited = first.notes.find((n) => n.path.endsWith("broken-symlink-handling.md"));
  const file = path.join(vault, edited.path);
  fs.writeFileSync(file, "---\ntitle: \"Symlink note rewritten\"\ndeprecated: true\n---\n\n# Symlink note rewritten\n\nNew body.\n");
  const next = buildVaultIndex(vault, { previous });
  const after = next.notes.find((n) => n.path === edited.path);
  assert.equal(after.terms.reusedmark, undefined, "the edited note was read again");
  assert.equal(after.deprecated, true, "its new frontmatter is seen");
  assert.ok(next.notes.filter((n) => n.path !== edited.path).every((n) => n.terms.reusedmark === 1), "the others were reused");
  assert.equal(next.n, first.n);
  // Same answer as a full build, apart from the marks.
  const full = buildVaultIndex(vault);
  assert.deepEqual(full.notes.map((n) => n.path).sort(), next.notes.map((n) => n.path).sort());
  assert.equal(full.fileSignature, next.fileSignature);
});

test("a stale note survives incremental rebuilds but not the full rebuild when the TTL runs out", () => {
  const vault = makeVault();
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "om-idx-ttl-")), "vault-index.json");
  const first = loadVaultIndex(vault, { cachePath });
  // Simulate what the incremental check cannot see (content changed, mtime and size restored): the cached
  // note carries something the file does not say.
  const rel = first.notes.find((n) => n.path.endsWith("broken-symlink-handling.md")).path;
  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  cached.notes.find((n) => n.path === rel).terms.stalemark = 1;
  fs.writeFileSync(cachePath, JSON.stringify(cached));
  const stale = (index) => Boolean(index.notes.find((n) => n.path === rel).terms.stalemark);

  assert.ok(stale(loadVaultIndex(vault, { cachePath, now: Date.now() + 60_000 })), "within the TTL the cache is served");
  // An edit to another note inside the TTL is incremental: the unchanged note is reused, stale or not.
  fs.writeFileSync(path.join(vault, "20-Projects", "plugin-1f6a88a6", "wiki", "knowledge", "vault-health-inspection-contract.md"), "---\ntitle: \"Vault 健康审计契约（修订）\"\n---\n\n# 修订\n");
  const edited = loadVaultIndex(vault, { cachePath, now: Date.now() + 120_000 });
  assert.ok(stale(edited));
  assert.equal(edited.fullBuiltAt, first.fullBuiltAt, "an incremental rebuild keeps the last full read time");

  const later = loadVaultIndex(vault, { cachePath, now: first.fullBuiltAt + 11 * 60 * 1000 });
  assert.ok(!stale(later), "the full rebuild reads every file again");
  assert.ok(later.fullBuiltAt >= first.fullBuiltAt);
});
