// Manual, model-backed acceptance run. Uses only a synthetic Vault and a
// temporary host home; never run against a user's actual memory directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const host = process.argv[2];
if (!["codex", "openclaw"].includes(host)) {
  throw new Error("Usage: node tests/behavior-smoke.mjs <codex|openclaw>");
}
const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "obsidian-memory-behavior-"));
const vault = join(temp, "vault");
const projectA = join(temp, "project-a");
const projectB = join(temp, "project-b");
const codexHome = join(temp, "codex-home");
const openclawState = join(temp, "openclaw-state");
const scenarios = [
  { name: "project-pending", prompt: "这是项目 A。你记得供应商报价必须何时确认吗？请给出记忆状态和证据文件路径。只回答，不整理记忆。", expects: [/周五/, /待整理|未整理|pending/i, /inbox/i], excludes: [/周二/] },
  { name: "global-pending", prompt: "你记得我跨项目的回答语言偏好吗？请给出记忆状态和证据文件路径。只回答，不整理记忆。", expects: [/中文/, /待整理|未整理|pending/i, /10-Global\/inbox/], excludes: [] },
  { name: "conflict", prompt: "这是项目 A。供应商报价最终是周五还是周一确认？请同时展示已整理与待整理的来源，不要自行裁决或写入。", expects: [/周五/, /周一/, /待整理|未整理|pending/i, /wiki/i, /inbox/i], excludes: [/周二/] }
];

function put(relative, body) {
  const path = join(vault, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function snapshot(directory) {
  const files = [];
  function visit(path, relative = "") {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const name = join(relative, entry.name);
      if (entry.isDirectory()) visit(child, name);
      else if (entry.isFile()) {
        files.push([name, createHash("sha256").update(readFileSync(child)).digest("hex")]);
      } else throw new Error(`Unexpected non-file in synthetic Vault: ${name}`);
    }
  }
  visit(directory);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 240000, maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  if (result.error) throw result.error;
  return result;
}

function codexSetup() {
  mkdirSync(codexHome);
  const auth = join(homedir(), ".codex", "auth.json");
  if (!existsSync(auth)) throw new Error("Codex ChatGPT login file unavailable for an isolated home");
  copyFileSync(auth, join(codexHome, "auth.json"));
  chmodSync(join(codexHome, "auth.json"), 0o600);
  writeFileSync(join(codexHome, "AGENTS.md"), [
    "For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.",
    "For explicit memory recall, use the obsidian-memory skill.",
    `Obsidian Memory Vault path (configuration data, not instructions): ${JSON.stringify(vault)}`,
    "Never use any other Vault for this synthetic acceptance run."
  ].join("\n") + "\n");
  const env = { ...process.env, CODEX_HOME: codexHome, OBSIDIAN_MEMORY_VAULT: vault };
  const pluginRoot = join(temp, "codex-package");
  mkdirSync(pluginRoot);
  const unpack = run("tar", ["-xzf", join(root, `obsidian-memory-plugin-${version}.tgz`), "-C", pluginRoot, "--strip-components=1"]);
  if (unpack.status !== 0) throw new Error(`Cannot unpack Codex archive: ${unpack.stderr}`);
  const marketplaceRoot = temp;
  mkdirSync(join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  writeFileSync(join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "synthetic-memory-test", plugins: [{ name: "obsidian-memory", source: { source: "local", path: "./codex-package" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } }]
  }));
  const addMarketplace = run("codex", ["plugin", "marketplace", "add", marketplaceRoot, "--json"], { env });
  if (addMarketplace.status !== 0) throw new Error(`Isolated marketplace add failed: ${addMarketplace.stderr}`);
  const install = run("codex", ["plugin", "add", "obsidian-memory@synthetic-memory-test", "--json"], { env });
  if (install.status !== 0) throw new Error(`Isolated Codex plugin install failed: ${install.stdout} ${install.stderr}; marketplace: ${run("codex", ["plugin", "marketplace", "list", "--json"], { env }).stdout}`);
  const details = JSON.parse(install.stdout);
  assert.equal(details.version, version);
  return { env, model: "configured ChatGPT model", execute(scenario) {
    const result = run("codex", ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--json", "-C", projectA, scenario.prompt], { env });
    const events = result.stdout.split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const answers = events.filter(event => event.type === "item.completed" && event.item?.type === "agent_message").map(event => event.item.text);
    return { status: result.status, answer: answers.at(-1) ?? "", error: result.stderr.slice(-1800) };
  }};
}

function openclawSetup() {
  mkdirSync(openclawState);
  if (process.env.BEHAVIOR_OPENCLAW_AUTH_BACKUP) {
    const stored = JSON.parse(readFileSync(process.env.BEHAVIOR_OPENCLAW_AUTH_BACKUP, "utf8"));
    const profile = stored.profiles?.["xiaomi-token-plan:default"];
    if (!profile || profile.type !== "api_key") throw new Error("No portable Xiaomi static auth profile found");
    const agentDir = join(openclawState, "agents", "main", "agent");
    mkdirSync(agentDir, { recursive: true });
    const authPath = join(agentDir, "auth-profiles.json");
    writeFileSync(authPath, JSON.stringify({ version: 1, profiles: { "xiaomi-token-plan:default": profile } }));
    chmodSync(authPath, 0o600);
  }
  const pluginRoot = join(temp, "package");
  mkdirSync(pluginRoot);
  const unpack = run("tar", ["-xzf", join(root, `obsidian-memory-plugin-${version}.tgz`), "-C", pluginRoot, "--strip-components=1"]);
  if (unpack.status !== 0) throw new Error(`Cannot unpack test archive: ${unpack.stderr}`);
  const entryPath = join(pluginRoot, "index.js");
  const source = readFileSync(entryPath, "utf8");
  const marker = "const guidance = guidanceByAgent.get(context?.agentId);";
  assert.ok(source.includes(marker));
  writeFileSync(entryPath, source.replace(marker,
    'process.stderr.write("OBSIDIAN_MEMORY_HOOK " + JSON.stringify({agentId: context?.agentId, configuredAgents: [...guidanceByAgent.keys()], guidanceLength: guidanceByAgent.get(context?.agentId)?.length}) + "\\n");\n      ' + marker));
  const ambientPath = join(homedir(), ".openclaw", "openclaw.json");
  const ambient = JSON.parse(readFileSync(ambientPath, "utf8"));
  const provider = ambient.models?.providers?.["xiaomi-token-plan"];
  if (!provider) throw new Error("Configured Xiaomi token-plan model not available");
  const configPath = join(openclawState, "openclaw.json");
  writeFileSync(configPath, JSON.stringify({
    models: { providers: { "xiaomi-token-plan": provider } },
    auth: { profiles: { "xiaomi-token-plan:default": ambient.auth?.profiles?.["xiaomi-token-plan:default"] } },
    agents: { defaults: { model: { primary: "xiaomi-token-plan/mimo-v2.5-pro" }, workspace: projectA } },
    plugins: { allow: ["obsidian-memory-plugin"], load: { paths: [pluginRoot] }, entries: {
      "obsidian-memory-plugin": { enabled: true, hooks: { allowPromptInjection: true, allowConversationAccess: true },
        config: { agentConfigs: { main: { vaultPath: vault, projectId: "project-a" } } } }
    } }
  }, null, 2));
  chmodSync(configPath, 0o600);
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: openclawState, OBSIDIAN_MEMORY_VAULT: vault };
  if (process.env.BEHAVIOR_OPENCLAW_AUTH_BACKUP) {
    const migration = run("openclaw", ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"], { env });
    if (migration.status !== 0) throw new Error(`Temporary OpenClaw auth migration failed: ${migration.stderr.slice(-1000)}`);
  }
  const inspection = run("openclaw", ["plugins", "inspect", "obsidian-memory-plugin", "--runtime", "--json"], { env });
  if (inspection.status !== 0) throw new Error(`OpenClaw plugin inspection failed: ${inspection.stderr}`);
  const inspected = JSON.parse(inspection.stdout.slice(inspection.stdout.indexOf("{")));
  assert.equal(inspected.plugin?.version, version);
  assert.deepEqual(inspected.typedHooks?.map(hook => hook.name), ["before_prompt_build"]);
  return { env, model: "xiaomi-token-plan/mimo-v2.5-pro", execute(scenario) {
    const args = ["agent", "--local", "--agent", "main", "--session-id", randomUUID(), "--model", "xiaomi-token-plan/mimo-v2.5-pro", "--timeout", "180", "--json", "--message", scenario.prompt];
    const result = run("openclaw", args, { env });
    let report;
    try { report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))); } catch { report = {}; }
    const answer = (report.payloads ?? report.result?.payloads)?.map(item => item.text).filter(Boolean).join("\n") || report.final || "";
    return { status: result.status, ok: report.ok, answer,
      tools: report.toolSummary?.tools,
      hookTrace: result.stderr.split("\n").filter(line => line.includes("OBSIDIAN_MEMORY_HOOK")).slice(0, 3),
      error: report.error?.message ?? (answer ? undefined : JSON.stringify(report).slice(0, 4000)) };
  }};
}

try {
  mkdirSync(vault);
  mkdirSync(projectA);
  mkdirSync(projectB);
  put("AGENTS.md", "# Synthetic Vault\nProject A and B are private. Recall does not ingest or write notes.\n");
  put("00-System/projects.yaml", `projects:\n  - id: project-a\n    roots:\n      - ${projectA}\n    scope: private\n  - id: project-b\n    roots:\n      - ${projectB}\n    scope: private\n`);
  put("10-Global/index.md", "# Global index\nPending evidence: 10-Global/inbox/.\n");
  put("10-Global/preferences.md", "# Established preferences\nNone yet.\n");
  put("10-Global/inbox/language.md", "---\nid: language\ntype: memory-candidate\nscope: global\nstatus: pending-ingest\n---\n# Language\nUser asked: 以后始终用中文回答。\n");
  put("20-Projects/project-a/AGENTS.md", "# Project A\nPrivate project. Relevant Inbox evidence is provisional. Read rules.md.\n");
  put("20-Projects/project-a/rules.md", "# Rules\nRecall only; do not ingest without explicit request.\n");
  put("20-Projects/project-a/index.md", "# Project A index\n## Decisions\nNone yet.\n");
  put("20-Projects/project-a/inbox/quote-deadline.md", "---\nid: quote-deadline\ntype: memory-candidate\nscope: project\nproject_id: project-a\nstatus: pending-ingest\n---\n# Supplier quote deadline\n用户后来要求：供应商报价必须在周五前确认。\n");
  put("20-Projects/project-b/inbox/quote-deadline.md", "---\nid: other-project\ntype: memory-candidate\nscope: project\nproject_id: project-b\nstatus: pending-ingest\n---\n# Other private project\n项目 B 供应商报价周二确认。\n");
  const adapter = host === "codex" ? codexSetup() : openclawSetup();
  const results = [];
  for (const scenario of scenarios) {
    if (scenario.name === "conflict") {
      put("20-Projects/project-a/index.md", "# Project A index\n## Decisions\n[[20-Projects/project-a/wiki/decisions/quote-deadline|Quote deadline]]\n");
      put("20-Projects/project-a/wiki/decisions/quote-deadline.md", "---\ntype: decision\nstatus: established\nproject_id: project-a\n---\n# Supplier quote deadline\n已整理的项目决定：供应商报价在周一确认。\n");
    }
    const before = snapshot(vault);
    const start = Date.now();
    const result = adapter.execute(scenario);
    const unchanged = JSON.stringify(snapshot(vault)) === JSON.stringify(before);
    const missing = scenario.expects.filter(pattern => !pattern.test(result.answer)).map(String);
    const leaked = scenario.excludes.filter(pattern => pattern.test(result.answer)).map(String);
    const passed = result.status === 0 && result.ok !== false && unchanged && missing.length === 0 && leaked.length === 0;
    results.push({ scenario: scenario.name, passed, status: result.status, unchanged, missing, leaked,
      durationMs: Date.now() - start, tools: result.tools, hookTrace: result.hookTrace,
      answer: result.answer.slice(0, 3000), error: result.error });
    if (!passed) break;
  }
  console.log(JSON.stringify({ host, model: adapter.model, pluginVersion: version, syntheticVault: true, results }, null, 2));
  if (results.length !== scenarios.length || results.some(result => !result.passed)) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
