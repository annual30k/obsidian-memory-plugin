import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { HERMES_PLUGIN_ID, HERMES_VAULT_KEY, hermesConfigArgs, runSetup } from "../scripts/setup-hermes.mjs";
import { findPython } from "../scripts/python.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Hermes adapter registers the namespaced Skill and a bounded proactive system section", () => {
  const program = String.raw`
import importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("obsidian_memory_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Ctx:
    def __init__(self, values): self.values, self.skills, self.sections = values, [], {}
    def get_config(self, key, default=None): return self.values.get(key, default)
    def register_skill(self, name, path, description=""): self.skills.append((name, Path(path).exists(), description))
    def register_system_prompt_section(self, ident, content, **kwargs): self.sections[ident] = (content, kwargs)
ctx = Ctx({"vault_path": sys.argv[2], "vault": "Personal", "project_id": "project_1"})
module.register(ctx)
content, options = ctx.sections[module.SECTION_ID]
empty = module.build_guidance({})
print(json.dumps({"skills": ctx.skills, "id": module.SECTION_ID, "options": options, "content": content({}), "empty": empty}))
`;
  const python = findPython();
  const vaultPath = join(root, "My Vault");
  const report = JSON.parse(execFileSync(python.command, [...python.args, "-c", program, root, vaultPath], { encoding: "utf8" }));
  assert.deepEqual(report.skills.map(([name, exists]) => [name, exists]), [["obsidian-memory", true]]);
  assert.equal(report.id, "obsidian-memory-plugin.workflow");
  assert.equal(report.options.position, "after_memory");
  assert.equal(report.options.max_chars, 1800);
  assert.match(report.content, /For code tasks, use the obsidian-memory skill/);
  assert.match(report.content, /obsidian-memory-plugin:obsidian-memory/);
  const connection = JSON.parse(report.content.split("\n").find(line => line.startsWith("{")));
  assert.equal(connection.vaultPath, vaultPath);
  assert.match(report.empty, /Do not guess a Vault/);
});

test("Hermes setup validates a user-selected Vault and writes only this plugin setting", async () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-hermes-"));
  try {
    const vault = join(root, "vault");
    mkdirSync(vault);
    assert.equal(HERMES_PLUGIN_ID, "obsidian-memory-plugin");
    assert.deepEqual(hermesConfigArgs(vault), ["config", "set", HERMES_VAULT_KEY, vault]);
    const calls = [];
    await runSetup(["--vault", vault, "--yes"], {
      input: new PassThrough(),
      output: new PassThrough(),
      run(command, args) {
        calls.push([command, args]);
        return { status: 0, stdout: "ok", stderr: "" };
      }
    });
    assert.deepEqual(calls, [["hermes", ["config", "set", HERMES_VAULT_KEY, vault]]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes without register_system_prompt_section still registers the skill and the hook, and reads config.yaml", () => {
  const program = String.raw`
import importlib.util, json, os, sys, tempfile
from pathlib import Path
root = Path(sys.argv[1])
home = tempfile.mkdtemp()
Path(home, "config.yaml").write_text("plugins:\n  entries:\n    obsidian-memory-plugin:\n      settings:\n        vault_path: " + sys.argv[2] + "\n", encoding="utf-8")
os.environ["HERMES_HOME"] = home
os.environ["OBSIDIAN_MEMORY_ROUTER_MODE"] = "off"
spec = importlib.util.spec_from_file_location("omp_new_hermes", root / "__init__.py", submodule_search_locations=[str(root)])
m = importlib.util.module_from_spec(spec); sys.modules[spec.name] = m; spec.loader.exec_module(m)
class Ctx:
    def __init__(self): self.skills, self.hooks = [], {}
    def register_skill(self, name, path, description=""): self.skills.append(name)
    def register_hook(self, name, cb): self.hooks[name] = cb
ctx = Ctx(); m.register(ctx)
os.environ["OBSIDIAN_MEMORY_ROUTER_MODE"] = "auto"
orig = m._evaluate_router
m._evaluate_router = lambda text, pid, mode: {"memoryAction": "default", "guidanceAppend": None, "trace": {}}
default_ctx = ctx.hooks["pre_llm_call"](user_message="写个脚本", session_id="s")
m._evaluate_router = lambda text, pid, mode: {"memoryAction": "skip", "guidanceAppend": "[Obsidian Memory: not needed for this turn]", "trace": {}}
skip_ctx = ctx.hooks["pre_llm_call"](user_message="你好", session_id="s")
print(json.dumps({"skills": ctx.skills, "hooks": sorted(ctx.hooks), "settings": m._settings(ctx), "default": default_ctx, "skip": skip_ctx}))
`;
  const python = findPython();
  const vaultPath = join(root, "My Vault");
  const r = JSON.parse(execFileSync(python.command, [...python.args, "-c", program, root, vaultPath], { encoding: "utf8" }));
  assert.deepEqual(r.skills, ["obsidian-memory"]);
  assert.deepEqual(r.hooks, ["pre_llm_call"]);
  assert.equal(r.settings.vaultPath, vaultPath);
  assert.match(r.default.context, /For code tasks, use the obsidian-memory skill/);
  assert.ok(r.default.context.includes(vaultPath));
  assert.equal(r.skip.context, "[Obsidian Memory: not needed for this turn]");
});
