// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPython } from "../scripts/python.mjs";
import { createOpenClawPlugin } from "../index.js";

// Every host entry point against a real Vault (current templates, a long sectioned manual, a deprecated
// note, an archived candidate) with no Laya at all: no service file, an unreachable endpoint, an empty
// plugin folder. Other hook tests point at a missing Vault, so they never reach the Vault index here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PID = "demo-1a2b3c4d";

function setup() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "om-no-laya-"));
  const vault = path.join(work, "vault");
  const projRoot = path.join(work, "proj");
  fs.mkdirSync(projRoot, { recursive: true });
  const w = (rel, text) => { const f = path.join(vault, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const derived = (type, title, extra = "") => `---\ntitle: "${title}"\ntype: ${type}\nscope: project\nproject_id: "${PID}"\nstatus: active\ndeprecated: false\ncreated: "2026-11-01"\nlast_updated: "2026-11-01"\nsensitivity: internal\nsources: []\n${extra}---\n`;
  w("00-System/projects.yaml", `projects:\n  - id: ${PID}\n    roots:\n      - "${projRoot}"\n    scope: private\n`);
  const P = `20-Projects/${PID}`;
  w(`${P}/wiki/knowledge/skip-empty-approver.md`, derived("knowledge", "流程设计跳过空缺审批节点操作说明") + "\n# 流程设计跳过空缺审批节点操作说明\n\n" +
    ["一、适用场景", "二、操作步骤", "三、注意事项"].map((h) => `## ${h}\n\n${"审批人不在岗时流程卡在空缺节点，在流程设计的节点属性里勾选审批人为空时自动跳过。".repeat(5)}\n`).join("\n"));
  w(`${P}/wiki/pitfalls/old.md`, derived("pitfall", "旧的发版流程", 'superseded_by: "[[new]]"\n').replace("deprecated: false", "deprecated: true") + "\n# 旧的发版流程\n");
  w(`${P}/inbox/archive/2026-11/cand-old.md`, `---\nid: "cand-old"\ntype: memory-candidate\nstatus: ingested\n---\n\n# 已归档\n`);
  const env = {
    ...process.env,
    OBSIDIAN_MEMORY_LAYA_DIR: path.join(work, "laya"),
    OBSIDIAN_MEMORY_SERVICE_FILE: path.join(work, "no-service.json"),
    OBSIDIAN_MEMORY_ENDPOINT: "http://127.0.0.1:1",
    OBSIDIAN_MEMORY_VAULT: vault,
    OBSIDIAN_MEMORY_DIGEST: "off",
    CODEX_HOME: path.join(work, "codex-home")
  };
  return { work, vault, projRoot, env };
}

// A prompt the Vault's words answer, an explicit save, a maintenance command and a greeting. The Hermes
// adapter runs from the repository folder, so its project comes from the project_root setting.
const VAULT_PROMPT = "流程设计里怎么跳过空缺审批节点";
const cases = [
  [VAULT_PROMPT, /look up memory first/u],
  ["记住：以后发版前先跑 npm run check", /asked to save something/u],
  ["把 inbox 候选全部入库", /memory maintenance operation/u],
  ["你好", /memory not needed/u]
];
const noCrash = (stderr) => assert.doesNotMatch(stderr ?? "", /TypeError|ReferenceError|SyntaxError|Cannot read prop/u);

test("without Laya, the Codex and Antigravity hooks still route explicit intents and Vault word matches", () => {
  const { work, projRoot, env } = setup();
  try {
    for (const [prompt, expected] of cases) {
      const codex = spawnSync(process.execPath, [path.join(root, "scripts", "codex-hook.mjs")], { input: JSON.stringify({ prompt, cwd: projRoot, session_id: "c1" }), encoding: "utf8", env, timeout: 15000 });
      assert.equal(codex.status, 0, prompt);
      noCrash(codex.stderr);
      assert.match(JSON.parse(codex.stdout).hookSpecificOutput?.additionalContext ?? "", expected, `codex: ${prompt}`);

      const transcript = path.join(work, `t-${cases.findIndex((c) => c[0] === prompt)}.jsonl`);
      fs.writeFileSync(transcript, JSON.stringify({ type: "USER_INPUT", step_index: 0, content: `<USER_REQUEST>${prompt}</USER_REQUEST>` }) + "\n");
      const agy = spawnSync(process.execPath, [path.join(root, "scripts", "antigravity-hook.mjs")], { input: JSON.stringify({ conversationId: `a-${transcript}`, transcriptPath: transcript, cwd: projRoot }), encoding: "utf8", env, timeout: 15000 });
      assert.equal(agy.status, 0, prompt);
      noCrash(agy.stderr);
      assert.match(agy.stdout, expected, `antigravity: ${prompt}`);
    }
    const stop = spawnSync(process.execPath, [path.join(root, "scripts", "codex-stop-hook.mjs")], { input: JSON.stringify({ session_id: "c1", cwd: projRoot, last_assistant_message: "好的。" }), encoding: "utf8", env, timeout: 15000 });
    assert.equal(stop.status, 0);
    noCrash(stop.stderr);
    // The index was built and no vector cache was written (there is no retriever).
    const cache = path.join(env.OBSIDIAN_MEMORY_LAYA_DIR, "cache");
    assert.ok(fs.readdirSync(cache).some((f) => f.startsWith("vault-index-")));
    assert.ok(!fs.readdirSync(cache).some((f) => f.startsWith("vault-embeddings-")));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("without Laya, the Hermes adapter and the OpenClaw plugin give the same hints", async () => {
  const { work, vault, projRoot, env } = setup();
  try {
    const python = findPython();
    if (python) {
      const script = String.raw`
import importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1]); prompts = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("obsidian_memory_plugin", root / "__init__.py")
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
class Ctx:
    hooks = {}
    def get_config(self, key, default=None):
        return {"memory_router_mode": "auto", "vault_path": sys.argv[3], "project_root": sys.argv[4]}.get(key, default)
    def register_skill(self, *a, **k): pass
    def register_system_prompt_section(self, *a, **k): pass
    def register_hook(self, name, cb): self.hooks[name] = cb
c = Ctx(); m.register(c)
print(json.dumps([json.dumps(c.hooks["pre_llm_call"](user_message=p, session_id="h1"), ensure_ascii=False) for p in prompts]))
`;
      const r = spawnSync(python.command, [...python.args, "-c", script, root, JSON.stringify(cases.map((c) => c[0])), vault, projRoot], { encoding: "utf8", env, timeout: 60000 });
      assert.equal(r.status, 0, r.stderr);
      const outs = JSON.parse(r.stdout.trim().split("\n").pop());
      cases.forEach(([prompt, expected], i) => assert.match(outs[i], expected, `hermes: ${prompt}`));
    }

    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const handlers = {};
      createOpenClawPlugin().register({
        pluginConfig: { agentConfigs: { main: { vaultPath: vault, projectRoot: projRoot } }, memoryJudge: { mode: "auto" } },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        on(event, handler) { handlers[event] = handler; },
        onDispose() {}
      });
      for (const [i, [prompt, expected]] of cases.entries()) {
        const ctx = { runId: `r${i}`, sessionId: "o1", sessionKey: "o1", agentId: "main" };
        const built = await handlers.before_prompt_build({ prompt, messages: [{ role: "user", content: prompt }] }, ctx);
        assert.match(built?.prependContext ?? "", expected, `openclaw: ${prompt}`);
        if (handlers.before_agent_run) assert.equal(await handlers.before_agent_run({ prompt, messages: [], systemPrompt: "" }, ctx), undefined);
      }
    } finally {
      for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("without Laya, laya search falls back to words and laya index says the service is missing", () => {
  const { work, vault, projRoot, env } = setup();
  try {
    const search = spawnSync(process.execPath, [path.join(root, "scripts", "search-vault.mjs"), "审批人不在岗怎么办", "--vault", vault, "--cwd", projRoot, "--json"], { encoding: "utf8", env, timeout: 15000 });
    assert.equal(search.status, 0, search.stderr);
    const found = JSON.parse(search.stdout);
    assert.equal(found.mode, "lexical");
    assert.match(found.results[0]?.path ?? "", /skip-empty-approver\.md$/u);
    assert.ok(!found.results.some((r) => r.deprecated), "deprecated notes stay out by default");

    const index = spawnSync(process.execPath, [path.join(root, "scripts", "index-vault.mjs"), "--vault", vault], { encoding: "utf8", env, timeout: 30000 });
    assert.equal(index.status, 1);
    assert.match(index.stderr, /Laya service is not answering/u);
    noCrash(index.stderr);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
