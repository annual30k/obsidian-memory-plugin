// Verify the release archive itself, without changing installed host plugins or a real Vault.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findPython } from "../scripts/python.mjs";

let archivePath = process.argv[2];
if (!archivePath) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const expectedName = `${pkg.name}-${pkg.version}.tgz`;
  const candidates = [
    join(process.cwd(), "dist", expectedName),
    join(process.cwd(), expectedName),
  ];
  archivePath = candidates.find(c => existsSync(c));
}
if (!archivePath) throw new Error("Usage: node tests/host-package-smoke.mjs <package.tgz>");
const archive = resolve(archivePath);
const sandbox = mkdtempSync(join(tmpdir(), "obsidian-memory-hosts-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", sandbox], { timeout: 15000 });
  const root = join(sandbox, "package");
  const packageInfo = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const codexInfo = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  const openclawInfo = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
  const antigravityInfo = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
  const hermesInfo = readFileSync(join(root, "plugin.yaml"), "utf8");
  const skill = readFileSync(join(root, "skills", "obsidian-memory", "SKILL.md"), "utf8");
  const icon = readFileSync(join(root, "assets", "icon.png"));
  assert.equal(codexInfo.version, packageInfo.version);
  assert.equal(codexInfo.interface.composerIcon, "./assets/icon.png");
  assert.equal(codexInfo.interface.logo, "./assets/icon.png");
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.ok(marketplace.plugins.some(plugin => plugin.name === codexInfo.name));
  assert.equal(openclawInfo.version, packageInfo.version);
  assert.equal(antigravityInfo.version, packageInfo.version);
  assert.equal(antigravityInfo.name, packageInfo.name);
  assert.match(hermesInfo, new RegExp(`^version: ${packageInfo.version.replaceAll(".", "\\.")}$`, "m"));
  assert.match(skill, /pending `inbox\/`/);
  execFileSync(process.execPath, [join(root, "scripts", "validate-codex-plugin.mjs")], {
    cwd: root, timeout: 15000
  });
  execFileSync(process.execPath, [join(root, "scripts", "validate-antigravity-plugin.mjs")], {
    cwd: root, timeout: 15000
  });

  const vault = join(sandbox, "vault");
  mkdirSync(vault);
  const agents = join(sandbox, "AGENTS.md");
  execFileSync(process.execPath, [join(root, "scripts", "setup-codex.mjs"),
    "--vault", vault, "--agents-file", agents, "--yes"], { timeout: 15000 });
  const codexRules = readFileSync(agents, "utf8");
  assert.match(codexRules, /For code tasks, use the obsidian-memory skill/);
  assert.ok(codexRules.includes(JSON.stringify(vault)));

  const gemini = join(sandbox, "GEMINI.md");
  const pluginDir = join(sandbox, "plugins", "obsidian-memory-plugin");
  execFileSync(process.execPath, [join(root, "scripts", "setup-antigravity.mjs"),
    "--vault", vault, "--gemini-file", gemini, "--plugin-dir", pluginDir, "--yes"], { timeout: 15000 });
  const antigravityRules = readFileSync(gemini, "utf8");
  assert.match(antigravityRules, /For code tasks, use the obsidian-memory skill/);
  assert.ok(antigravityRules.includes(JSON.stringify(vault)));

  const hermesProbe = String.raw`
import importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("obsidian_memory_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.skills, self.sections = [], {}
    def get_config(self, key, default=None): return {"vault_path": sys.argv[2]}.get(key, default)
    def register_skill(self, name, path, description=""): self.skills.append((name, str(path)))
    def register_system_prompt_section(self, ident, content, **kwargs): self.sections[ident] = content({})
ctx = Ctx()
module.register(ctx)
print(json.dumps({"skills": ctx.skills, "guidance": ctx.sections[module.SECTION_ID]}))
`;
  const python = findPython();
  const hermes = JSON.parse(execFileSync(python.command, [...python.args, "-c", hermesProbe, root, vault], {
    encoding: "utf8", timeout: 15000
  }));
  assert.equal(hermes.skills[0][0], "obsidian-memory");
  assert.equal(hermes.skills[0][1], join(root, "skills", "obsidian-memory", "SKILL.md"));
  assert.match(hermes.guidance, /obsidian-memory-plugin:obsidian-memory/);
  assert.ok(hermes.guidance.includes(vault));
  console.log(`Archive host smoke passed for Antigravity, OpenClaw, Codex and Hermes manifests and adapters: ${packageInfo.version}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
