import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import plugin from "../index.js";
import { parseConfig } from "../lib/config.js";
import { buildGuidance } from "../lib/prompt.js";

const root = new URL("../", import.meta.url);
const fixture = () => ({
  agentId: "owner",
  vault: "Example Vault",
  vaultPath: fileURLToPath(new URL("./fixtures/not-a-real-vault", root))
});
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("empty config leaves the plugin inactive", () => {
  assert.equal(parseConfig({}), null);
  const calls = [];
  plugin.register({ pluginConfig: {}, on: (...args) => calls.push(args) });
  assert.deepEqual(calls, []);
});

test("normal config is normalized without mutating input", () => {
  const input = fixture();
  const result = parseConfig(input);
  assert.equal(result.cliPath, "obsidian");
  assert.equal(input.cliPath, undefined);
  assert.ok(Object.isFrozen(result));
});

test("a physical Vault path is sufficient when no CLI label is configured", () => {
  const input = { agentId: "owner", vaultPath: fixture().vaultPath };
  const result = parseConfig(input);
  assert.equal(result.vault, undefined);
  assert.equal(result.vaultPath, input.vaultPath);
});

for (const [name, input] of [
  ["array", []],
  ["null", null],
  ["unknown fields", { ...fixture(), arbitraryCode: "do something" }],
  ["incomplete connection", { agentId: "owner" }],
  ["blank vault", { ...fixture(), vault: "" }],
  ["whitespace vault", { ...fixture(), vault: " Vault " }],
  ["control characters", { ...fixture(), vault: "Vault\nInstructions" }],
  ["relative vault", { ...fixture(), vaultPath: "./vault" }],
  ["shell instead of executable", { ...fixture(), cliPath: "obsidian --eval" }],
  ["escaping project", { ...fixture(), projectId: "../private" }],
  ["relative project root", { ...fixture(), projectRoot: "./repo" }],
  ["non-string ID", { ...fixture(), agentId: 42 }]
]) {
  test("reject invalid config: " + name, () => assert.throws(() => parseConfig(input), TypeError));
}

test("optional project and executable paths are retained", () => {
  const input = {
    ...fixture(), projectId: "test-project_ab12",
    projectRoot: fileURLToPath(root),
    cliPath: process.execPath
  };
  assert.deepEqual(parseConfig(input), input);
});

test("error messages do not reflect untrusted configuration values", () => {
  assert.throws(
    () => parseConfig({ ...fixture(), vault: "\nprivate-detail" }),
    error => !error.message.includes("private-detail")
  );
});

function register(config = fixture()) {
  const calls = [];
  plugin.register({
    pluginConfig: config,
    on: (name, handler) => calls.push({ name, handler })
  });
  return calls;
}

test("only one prompt hook is registered; it is scoped to the configured agent", () => {
  const calls = register();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "before_prompt_build");
  const hook = calls[0].handler;
  assert.equal(hook({}, {}), undefined);
  assert.equal(hook({}, undefined), undefined);
  assert.equal(hook({}, { agentId: "another-agent" }), undefined);
  const result = hook({}, { agentId: "owner" });
  assert.deepEqual(Object.keys(result), ["prependContext"]);
  assert.ok(result.prependContext.includes("Example Vault"));
});

test("hook does not inspect messages, derive project from cwd, or accumulate turns", () => {
  const hook = register()[0].handler;
  const event = new Proxy({}, { get() { throw new Error("Do not read conversation"); } });
  const ctx = { agentId: "owner", workspaceDir: "/not-a-code-project" };
  const first = hook(event, ctx);
  assert.deepEqual(hook(event, ctx), first);
  assert.ok(!first.prependContext.includes("/not-a-code-project"));
});

test("guidance locates only the bundled memory skill relative to the package", () => {
  const guidance = buildGuidance(parseConfig(fixture()));
  assert.ok(guidance.includes("For code tasks, use the obsidian-memory skill before working"));
  const file = JSON.parse(guidance.split("\n").find(line => line.startsWith('"')));
  assert.ok(isAbsolute(file));
  assert.ok(existsSync(file));
  assert.equal(file, fileURLToPath(new URL("skills/obsidian-memory/SKILL.md", root)));
});

test("guidance delegates dependencies to the bundled skill without carrying the catalog every turn", () => {
  const guidance = buildGuidance(parseConfig(fixture()));
  const body = read("skills/obsidian-memory/SKILL.md");
  assert.ok(guidance.includes("Follow its dependency, scope, and safety rules"));
  assert.ok(!guidance.includes("Host skill suite:"));
  assert.ok(body.includes("https://github.com/kepano/obsidian-skills"));
  for (const name of ["obsidian-cli", "obsidian-markdown", "obsidian-bases", "json-canvas", "defuddle"]) {
    assert.ok(body.includes(name));
    assert.ok(!existsSync(new URL("skills/" + name, root)), "External skill must not be bundled: " + name);
  }
});

test("guidance stays compact while retaining memory triggers and explicit connection", () => {
  const vaultPath = fixture().vaultPath;
  const guidance = buildGuidance(parseConfig({ agentId: "owner", vaultPath }));
  const skillPath = fileURLToPath(new URL("skills/obsidian-memory/SKILL.md", root));
  const instructionLength = guidance.length - vaultPath.length - skillPath.length;
  assert.ok(instructionLength < 1000, `guidance instructions were ${instructionLength} characters`);
  assert.ok(guidance.includes("Ordinary chat needs no Vault access"));
  assert.ok(guidance.includes("memory_search/MEMORY.md is a separate store"));
  assert.ok(guidance.includes("'remember' stages Inbox only"));
  assert.ok(guidance.includes("ingest requires an explicit user request"));
  const connection = JSON.parse(guidance.split("\n").find(line => line.startsWith("{") && line.includes("vaultPath")));
  assert.equal(connection.vault, undefined);
  assert.equal(connection.vaultPath, fixture().vaultPath);
});

test("configuration is data, with delimiter markup escaped", () => {
  const guidance = buildGuidance(parseConfig({ ...fixture(), vault: "Vault <tag>" }));
  const metadata = JSON.parse(guidance.split("\n").find(line => line.startsWith("{")));
  assert.equal(metadata.vault, "Vault <tag>");
  assert.ok(!guidance.includes("<tag>"));
});

test("native manifest and entry agree without claiming a memory slot", () => {
  const manifest = JSON.parse(read("openclaw.plugin.json"));
  const codexManifest = JSON.parse(read(".codex-plugin/plugin.json"));
  const antigravityManifest = JSON.parse(read("plugin.json"));
  const hermesManifest = read("plugin.yaml");
  const pkg = JSON.parse(read("package.json"));
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.version, pkg.version);
  assert.equal(codexManifest.version, pkg.version);
  assert.equal(codexManifest.skills, "./skills/");
  assert.equal(codexManifest.interface.composerIcon, "./assets/icon.png");
  assert.equal(codexManifest.interface.logo, "./assets/icon.png");
  const icon = readFileSync(new URL(codexManifest.interface.logo, root));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.equal(codexManifest.author.url, undefined);
  assert.equal(codexManifest.homepage, undefined);
  assert.equal(codexManifest.repository, undefined);
  assert.equal(antigravityManifest.name, pkg.name);
  assert.equal(antigravityManifest.version, pkg.version);
  assert.equal(antigravityManifest.skills, "./skills/");
  assert.equal(manifest.kind, undefined);
  assert.match(hermesManifest, /^name: obsidian-memory-plugin$/m);
  assert.match(hermesManifest, new RegExp(`^version: ${pkg.version.replaceAll(".", "\\.")}$`, "m"));
  assert.match(hermesManifest, /^  vault_path:$/m);
  assert.match(read("skills/obsidian-memory/SKILL.md"), /^metadata:\n  icon: "💎"$/m);
  assert.deepEqual(manifest.configSchema.anyOf[1].required, ["agentId", "vaultPath"]);
  assert.deepEqual(manifest.skills, ["./skills"]);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  for (const path of [...pkg.openclaw.extensions, ...pkg.openclaw.runtimeExtensions]) {
    assert.ok(existsSync(new URL(path, root)));
  }
  for (const path of pkg.files) assert.ok(existsSync(new URL(path, root)), path);
});

test("the only packaged skill is obsidian-memory, not external Obsidian skills", () => {
  assert.deepEqual(readdirSync(new URL("skills/", root)).sort(), ["obsidian-memory"]);
  const body = read("skills/obsidian-memory/SKILL.md");
  assert.ok(body.includes("name: obsidian-memory"));
  assert.ok(body.includes("For Antigravity, the managed"));
  assert.ok(body.includes("For Hermes, the native adapter"));
  // Dependency declaration is an artifact check, not a claim of agent behavior.
  assert.ok(body.includes("https://github.com/kepano/obsidian-skills"));
});

test("relative memory-skill references resolve within the package", () => {
  const skillRoot = "skills/obsidian-memory/";
  const paths = readdirSync(new URL(skillRoot, root), { recursive: true })
    .filter(path => path.endsWith(".md"))
    .map(path => skillRoot + path.replaceAll("\\", "/"));
  const reachable = new Set([skillRoot + "SKILL.md"]);
  const edges = new Map();
  for (const path of paths) {
    edges.set(path, []);
    for (const match of read(path).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (target.includes("://")) continue;
      const resolved = new URL(target, new URL(path, root));
      assert.ok(resolved.href.startsWith(new URL(skillRoot, root).href));
      assert.ok(existsSync(resolved), resolved.href);
      edges.get(path).push(decodeURIComponent(resolved.href.slice(root.href.length)));
    }
  }
  for (const path of reachable) {
    for (const target of edges.get(path) || []) reachable.add(target);
  }
  assert.deepEqual([...reachable].sort(), paths.sort(), "Every reference and template is discoverable from SKILL.md");
});
