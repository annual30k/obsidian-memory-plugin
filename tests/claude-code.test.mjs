// Isolation first: never touch the real ~/.claude, ~/.codex, ~/.laya or Vault, however this file is run.
import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookHost } from "../lib/memory-router/hook-host.js";
import { decideStop, lastAssistantMessageFromTranscript } from "../scripts/codex-stop-hook.mjs";
import { runSetup, updateClaudeMdContent, CLAUDE_INSTALL_COMMANDS } from "../scripts/setup-claude.mjs";
import { claudeCodeHost, collect } from "../scripts/doctor.mjs";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { START_MARKER, END_MARKER } from "../lib/managed-block.js";
import { listQueue, readQueueFile } from "../lib/memory-router/capture-queue.js";
import { parseMemoryJudgeConfig } from "../lib/config.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const silent = () => { let out = ""; return { write: (s) => { out += s; }, text: () => out }; };

test("the shared hooks tell Claude Code from Codex by transcript location, then by Claude Code's hook environment", () => {
  assert.equal(hookHost({ transcript_path: "/Users/a/.claude/projects/-Users-a-app/1234.jsonl" }, {}), "claude");
  assert.equal(hookHost({ transcript_path: "C:\\Users\\a\\.claude\\projects\\x\\1.jsonl" }, {}), "claude");
  assert.equal(hookHost({ transcript_path: "/Users/a/.codex/sessions/2026/11/28/rollout-x.jsonl" }, {}), "codex");
  assert.equal(hookHost({ transcript_path: "/data/cc/projects/x/1.jsonl" }, { CLAUDE_CONFIG_DIR: "/data/cc" }), "claude");
  assert.equal(hookHost({ transcript_path: "/data/cx/sessions/r.jsonl" }, { CODEX_HOME: "/data/cx", CLAUDE_PROJECT_DIR: "/w" }), "codex");
  assert.equal(hookHost({}, { CLAUDE_PROJECT_DIR: "/w" }), "claude");
  assert.equal(hookHost({}, {}), "codex", "Codex stays the default, as before");
});

test("the Stop hook reads a Claude Code transcript's last text reply, skipping tool-only lines and subagents", () => {
  const dir = tmp("om-cc-tr-");
  const file = path.join(dir, "s.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: "修一下导入" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "最终结论：保留本机版本。" }] } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent text" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    { type: "system", subtype: "turn_duration" }
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(lastAssistantMessageFromTranscript(file), "最终结论：保留本机版本。");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Claude Code turn is queued for the session digest under host claude", () => {
  const dir = tmp("om-cc-stop-");
  const queueDir = path.join(dir, "queue");
  const reply = "结论：Windows 包先不导入，等用户确认后再合并；这条决定要记住，因为它影响以后所有的同步步骤和导入顺序。".repeat(4);
  const out = decideStop({ session_id: "cc-1", transcript_path: "/Users/a/.claude/projects/p/cc-1.jsonl", last_assistant_message: reply }, {
    config: parseMemoryJudgeConfig({ mode: "auto" }), sessionStatePath: path.join(dir, "state.json"), queueDir, scheduleDigest: () => false
  });
  assert.equal(out, null, "never blocks a turn the user did not ask to remember");
  const [entry] = listQueue(queueDir);
  assert.ok(entry, "queued");
  assert.equal(readQueueFile(entry.file)[0].host, "claude");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the UserPromptSubmit hook answers Claude Code with the JSON it expects", () => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "codex-hook.mjs")], {
    input: JSON.stringify({ session_id: "cc-2", transcript_path: "/Users/a/.claude/projects/p/cc-2.jsonl", cwd: os.tmpdir(), hook_event_name: "UserPromptSubmit", prompt: "hi" }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: os.tmpdir() }, encoding: "utf8"
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(r.stderr, /"hostCapability":"claude_user_prompt_submit"/u);
});

test("setup-claude adds the managed block to CLAUDE.md, keeps the user's text, and the hooks then find the Vault", async () => {
  const home = tmp("om-cc-setup-");
  const vault = path.join(home, "Vault");
  fs.mkdirSync(vault);
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  put(claudeMd, "# My rules\n\nAlways answer briefly.\n");
  const output = silent();
  await runSetup(["--vault", vault, "--claude-md", claudeMd, "--yes"], { input: process.stdin, output });
  const text = fs.readFileSync(claudeMd, "utf8");
  assert.ok(text.startsWith("# My rules\n\nAlways answer briefly.\n"));
  assert.equal(text.split(START_MARKER).length, 2);
  assert.ok(text.includes(END_MARKER) && text.includes(JSON.stringify(vault)));
  assert.match(output.text(), /claude plugin install obsidian-memory --marketplace annual30k\/obsidian-memory-plugin/u);
  assert.equal(updateClaudeMdContent(text, vault), text, "running setup again changes nothing");
  assert.equal(resolveVaultPath({ env: { CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") }, home }), vault);
  assert.ok(CLAUDE_INSTALL_COMMANDS.every((c) => c.startsWith("claude plugin ")));
  fs.rmSync(home, { recursive: true, force: true });
});

test("doctor lists Claude Code with its installed version, enabled state and Vault", () => {
  const home = tmp("om-cc-doctor-");
  const env = { CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") };
  assert.equal(claudeCodeHost({ home, env }).install.installed, false);
  const installPath = path.join(home, ".claude", "plugins", "cache", "obsidian-memory", "obsidian-memory", "0.16.0");
  put(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "obsidian-memory@obsidian-memory": [{ scope: "user", installPath, version: "0.16.0" }] } }));
  put(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "obsidian-memory@obsidian-memory": true } }));
  put(path.join(home, ".claude", "CLAUDE.md"), updateClaudeMdContent("", home));
  const h = claudeCodeHost({ home, env });
  assert.deepEqual([h.host, h.enabled, h.install.installed, h.install.version, h.vaults[0]?.path], ["Claude Code", true, true, "0.16.0", home]);
  const report = collect({ home, env, packageVersion: "0.17.0" });
  assert.ok(report.issues.some((i) => i.startsWith("Claude Code: installed 0.16.0, this package is 0.17.0")));
  put(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "obsidian-memory@obsidian-memory": false } }));
  assert.equal(claudeCodeHost({ home, env }).enabled, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the Claude Code plugin files validate and stay in step with the Codex manifest", () => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "validate-claude-plugin.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.files.includes(".claude-plugin"), "the npm package carries the Claude Code manifest");
});
