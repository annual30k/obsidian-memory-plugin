// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractNoteSections, loadEmbeddingCache } from "../lib/memory-router/vault-index.js";
import { parseArgs, searchVault, formatSearchResults, main } from "../scripts/search-vault.mjs";

function makeSearchVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "om-search-vault-"));
  fs.mkdirSync(path.join(root, "00-System"), { recursive: true });
  fs.writeFileSync(path.join(root, "00-System", "projects.yaml"), [
    "projects:",
    "  - id: oa-c9a48417",
    "    roots:",
    "      - /work/oa",
    "    scope: private",
    "  - id: other-11111111",
    "    roots: []",
    "    scope: private",
    ""
  ].join("\n"));

  const oaWiki = path.join(root, "20-Projects", "oa-c9a48417", "wiki", "knowledge");
  fs.mkdirSync(oaWiki, { recursive: true });
  const filler = "前置基础巡检操作说明。".repeat(65);
  fs.writeFileSync(path.join(oaWiki, "portal-manual.md"), [
    "---",
    'title: "门户管理后台综合操作手册"',
    "type: knowledge",
    "status: active",
    "deprecated: false",
    "---",
    "",
    "# 门户管理后台综合操作手册",
    "",
    "## 一、基础登录与配置",
    filler,
    "```python",
    "# ## not a markdown heading inside code",
    "def helper():",
    "    return True",
    "```",
    "",
    "## 四、员工兼职信息新增",
    "进入组织人员管理页签，点击新增兼职并保存修改。",
    "",
    "## Related notes",
    "- [[index]]"
  ].join("\n"));

  fs.writeFileSync(path.join(oaWiki, "old-portal.md"), [
    "---",
    'title: "旧版员工兼职入口"',
    "type: knowledge",
    "status: active",
    "deprecated: true",
    "---",
    "",
    "# 旧版员工兼职入口",
    "",
    "## 旧入口说明",
    "旧版员工兼职信息新增入口。"
  ].join("\n"));

  const otherWiki = path.join(root, "20-Projects", "other-11111111", "wiki", "knowledge");
  fs.mkdirSync(otherWiki, { recursive: true });
  fs.writeFileSync(path.join(otherWiki, "secret-oa.md"), "---\ntitle: \"Other project 兼职\"\n---\n\n## 兼职\n\n不应泄漏到 oa 项目。\n");

  const globalWiki = path.join(root, "10-Global", "wiki");
  fs.mkdirSync(globalWiki, { recursive: true });
  fs.writeFileSync(path.join(globalWiki, "prefs.md"), "---\ntitle: \"全局响应规范\"\n---\n\n## 输出语言\n\n默认使用中文回答。\n");
  return root;
}

test("extractNoteSections returns accurate 1-based line ranges and ignores # headings inside fenced code", () => {
  const vault = makeSearchVault();
  try {
    const file = path.join(vault, "20-Projects", "oa-c9a48417", "wiki", "knowledge", "portal-manual.md");
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    const sections = extractNoteSections(content);
    assert.ok(!sections.some((s) => s.heading.includes("not a markdown heading")));
    const part4 = sections.find((s) => s.heading === "四、员工兼职信息新增");
    assert.ok(part4);
    assert.equal(lines[part4.startLine - 1], "## 四、员工兼职信息新增");
    assert.ok(lines[part4.endLine - 1].includes("保存修改"));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test("searchVault finds late manual sections, isolates projects, and skips deprecated notes unless requested", async () => {
  const vault = makeSearchVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-search-cache-"));
  try {
    const res = await searchVault({
      vaultPath: vault,
      query: "员工兼职信息新增",
      projectId: "oa-c9a48417",
      semantic: false,
      indexCachePath: path.join(dir, "idx.json")
    });
    assert.equal(res.mode, "lexical");
    assert.equal(res.results.length, 1);
    assert.match(res.results[0].path, /portal-manual\.md$/u);
    assert.equal(res.results[0].section.heading, "四、员工兼职信息新增");
    assert.ok(res.results[0].section.startLine > 10);
    assert.match(res.results[0].snippet, /新增兼职并保存修改/u);

    // With --include-deprecated, deprecated note is also returned
    const withDep = await searchVault({
      vaultPath: vault,
      query: "旧版员工兼职",
      projectId: "oa-c9a48417",
      includeDeprecated: true,
      semantic: false,
      indexCachePath: path.join(dir, "idx.json")
    });
    assert.ok(withDep.results.some((r) => r.path.endsWith("old-portal.md") && r.deprecated === true));

    // Hybrid/semantic mode using mock embedFn finds paraphrased late sections even without word overlap
    const toyEmbed = async (texts) => ({
      model: "toy",
      vectors: texts.map((t) => (t.includes("兼职") || t.includes("part-time") ? [1, 0] : [0, 1]))
    });
    const semRes = await searchVault({
      vaultPath: vault,
      query: "part-time",
      projectId: "oa-c9a48417",
      semantic: true,
      embedFn: toyEmbed,
      indexCachePath: path.join(dir, "idx.json"),
      embeddingCachePath: path.join(dir, "emb.json")
    });
    assert.equal(semRes.mode, "semantic");
    assert.match(semRes.results[0].path, /portal-manual\.md$/u);
    assert.equal(semRes.results[0].section.heading, "四、员工兼职信息新增");

    // CLI parseArgs & main --json output
    const parsed = parseArgs(["员工兼职", "--project", "oa-c9a48417", "--limit", "3", "--include-deprecated", "--no-semantic", "--json"]);
    assert.equal(parsed.query, "员工兼职");
    assert.equal(parsed.limit, 3);
    assert.equal(parsed.includeDeprecated, true);
    assert.equal(parsed.semantic, false);
    assert.equal(parsed.json, true);

    let stdout = "";
    const code = await main(["员工兼职信息新增", "--vault", vault, "--project", "oa-c9a48417", "--no-semantic", "--json"], { write: (s) => { stdout += s; } });
    assert.equal(code, 0);
    const jsonOut = JSON.parse(stdout);
    assert.equal(jsonOut.results[0].section.heading, "四、员工兼职信息新增");
    assert.match(formatSearchResults(jsonOut), /portal-manual\.md:\d+-\d+/u);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("searchVault finds words that only appear in a note's body, and an unresolved project never searches every project", async () => {
  const vault = makeSearchVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-search-cache-"));
  try {
    // "保存修改" is in no title, heading or identifier: only the body has it.
    const body = await searchVault({ vaultPath: vault, query: "保存修改", projectId: "oa-c9a48417", semantic: false, indexCachePath: path.join(dir, "idx.json") });
    assert.match(body.results[0]?.path ?? "", /portal-manual\.md$/u);
    assert.equal(body.results[0].section.heading, "四、员工兼职信息新增");

    const unresolved = await searchVault({ vaultPath: vault, query: "兼职", cwd: "/nowhere", semantic: false, indexCachePath: path.join(dir, "idx.json") });
    assert.equal(unresolved.projectUnresolved, true);
    assert.ok(unresolved.results.every((r) => r.projectId === "global"), JSON.stringify(unresolved.results));
    assert.match(formatSearchResults(unresolved), /--project <id> or --scope all/u);

    // Naming the project in the query still reaches it.
    const named = await searchVault({ vaultPath: vault, query: "other 兼职", cwd: "/nowhere", semantic: false, indexCachePath: path.join(dir, "idx.json") });
    assert.ok(named.results.some((r) => r.projectId === "other-11111111"));
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one semantic search embeds every pending note, not just one hook-sized batch", async () => {
  const vault = makeSearchVault();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-search-cache-"));
  try {
    const wiki = path.join(vault, "20-Projects", "oa-c9a48417", "wiki", "knowledge");
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(wiki, `bulk-${i}.md`), `---\ntitle: "批量笔记 ${i}"\n---\n\n# 批量笔记 ${i}\n\n第 ${i} 篇。\n`);
    let calls = 0;
    const toyEmbed = async (texts) => { calls++; return { model: "toy", vectors: texts.map((t) => (t.includes("兼职") ? [1, 0] : [0, 1])) }; };
    const embeddingCachePath = path.join(dir, "emb.json");
    await searchVault({ vaultPath: vault, query: "part-time", projectId: "oa-c9a48417", semantic: true, embedFn: toyEmbed, indexCachePath: path.join(dir, "idx.json"), embeddingCachePath });
    const cache = loadEmbeddingCache(embeddingCachePath, { vaultPath: vault, model: "toy" });
    assert.ok(Object.keys(cache.entries).length >= 74, `embedded ${Object.keys(cache.entries).length}`);
    assert.ok(calls >= 4, "several batches in one call");
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
