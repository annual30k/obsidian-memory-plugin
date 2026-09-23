import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  assertSafeHookScriptPath,
  buildCodexHookCommand,
  buildCodexHooksConfig,
  formatWindowsSafePath,
  mergeCodexHooks
} from "../scripts/setup-codex.mjs";
import {
  buildAntigravityHookCommand,
  buildAntigravityHooksConfig,
  mergeAntigravityHooks
} from "../scripts/setup-antigravity.mjs";
import { extractPromptText, strictBlockReason } from "../scripts/codex-hook.mjs";
import { buildLayaActionNotice, buildLayaNotice } from "../lib/prompt.js";
import { extractLastUserPrompt } from "../scripts/antigravity-hook.mjs";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { DEFAULT_MEMORY_JUDGE, HOST_HOOK_TIMEOUT_SECONDS, parseMemoryJudgeConfig } from "../lib/config.js";
import openclawPlugin, { createOpenClawPlugin } from "../index.js";
import { findPython } from "../scripts/python.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("Codex hooks.json conforms to official discovery structure and nested schema", () => {
  // 1. Verify .codex-plugin/plugin.json explicitly points to hooks file
  const pluginManifestPath = join(root, ".codex-plugin", "plugin.json");
  assert.ok(existsSync(pluginManifestPath), ".codex-plugin/plugin.json must exist");
  const manifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
  assert.equal(manifest.hooks, "./hooks/hooks.json", "plugin.json must explicitly point to ./hooks/hooks.json");

  // 2. Verify hooks/hooks.json exists
  const hooksFile = join(root, "hooks", "hooks.json");
  assert.ok(existsSync(hooksFile), "hooks/hooks.json must exist in official plugin hooks path");

  const raw = readFileSync(hooksFile, "utf8");
  const data = JSON.parse(raw);

  assert.ok(data.hooks, "Root must contain 'hooks' object");
  assert.ok(Array.isArray(data.hooks.UserPromptSubmit), "UserPromptSubmit must be an array");
  assert.ok(data.hooks.UserPromptSubmit.length > 0, "UserPromptSubmit array must not be empty");

  // Official format: each item in event array MUST be a container with a 'hooks' array
  const container = data.hooks.UserPromptSubmit[0];
  assert.ok(container.hooks, "UserPromptSubmit items must contain a 'hooks' array");
  assert.ok(Array.isArray(container.hooks), "container.hooks must be an array");

  const innerHook = container.hooks[0];
  assert.equal(innerHook.type, "command");
  assert.match(innerHook.command, /\$\{PLUGIN_ROOT\}\/scripts\/codex-hook\.mjs/, "Must prioritize official PLUGIN_ROOT");
  assert.equal(innerHook.timeout, HOST_HOOK_TIMEOUT_SECONDS);
});

test("host hook timeouts leave room for a Laya cold start", () => {
  // Node startup + health handshake + cold-start inference must finish before the host kills the hook.
  const budgetMs = DEFAULT_MEMORY_JUDGE.healthTimeout + DEFAULT_MEMORY_JUDGE.coldStartTimeout + 2000;
  assert.ok(HOST_HOOK_TIMEOUT_SECONDS * 1000 > budgetMs, "HOST_HOOK_TIMEOUT_SECONDS too small for cold start");
  const codex = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
  const antigravity = JSON.parse(readFileSync(join(root, "hooks.json"), "utf8"));
  assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].timeout, HOST_HOOK_TIMEOUT_SECONDS);
  assert.equal(antigravity["obsidian-memory-router"].PreInvocation[0].timeout, HOST_HOOK_TIMEOUT_SECONDS);
  const hermes = readFileSync(join(root, "__init__.py"), "utf8");
  assert.match(hermes, new RegExp(`^HOST_HOOK_TIMEOUT_SECONDS = ${HOST_HOOK_TIMEOUT_SECONDS}$`, "m"));
});

test("Windows/cross-shell command safety: normal paths pass round-trip, dangerous expansions (%VAR%, !VAR!, $VAR, $(cmd), `cmd`, quotes, CRLF/NUL) strictly rejected", () => {
  // 1. Valid Windows path with spaces, drive letter, parentheses (x86), &, +, ^
  const winPathValid = "C:\\Dev & Lab (x86)\\Agent+Code^\\scripts\\codex-hook.mjs";
  const normalizedValid = formatWindowsSafePath(winPathValid);
  assert.equal(normalizedValid, "C:/Dev & Lab (x86)/Agent+Code^/scripts/codex-hook.mjs");

  const codexCmd = buildCodexHookCommand(winPathValid);
  assert.equal(codexCmd, 'node "C:/Dev & Lab (x86)/Agent+Code^/scripts/codex-hook.mjs"');

  const agyCmd = buildAntigravityHookCommand(winPathValid);
  assert.equal(agyCmd, 'node "C:/Dev & Lab (x86)/Agent+Code^/scripts/codex-hook.mjs"');

  // JSON round-trip must survive without corruption
  const config = buildCodexHooksConfig(winPathValid);
  const serialized = JSON.stringify(config, null, 2);
  const parsedBack = JSON.parse(serialized);
  assert.deepEqual(parsedBack, config, "Config must survive JSON round-trip without corruption");
  assert.equal(parsedBack.hooks.UserPromptSubmit[0].hooks[0].command, codexCmd);

  const EXPECTED_ERR_MSG = "Invalid hook scriptPath: path contains unsafe shell expansion, substitution, quote, or control characters";

  // 2. Security validation: reject dangerous shell expansions, substitutions, quotes, and control chars
  // cmd.exe %VAR% expansion
  assert.throws(
    () => buildCodexHookCommand("C:\\My Agents\\Agent%TEMP%\\hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  // cmd.exe delayed expansion !VAR!
  assert.throws(
    () => buildCodexHookCommand("C:\\My Agents\\Agent!TEMP!\\hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  // POSIX variable expansion $VAR
  assert.throws(
    () => buildAntigravityHookCommand("/home/user/$HOME/hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  // POSIX command substitution $(cmd)
  assert.throws(
    () => buildCodexHookCommand("/home/user/$(whoami)/hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  // Backtick command substitution `cmd`
  assert.throws(
    () => buildAntigravityHookCommand("/home/user/`whoami`/hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  // Double quotes inside path
  assert.throws(
    () => buildCodexHookCommand('C:\\My "Agents"\\hook.mjs'),
    { message: EXPECTED_ERR_MSG }
  );
  // CRLF/control character injection
  assert.throws(
    () => buildCodexHookCommand("C:\\My Agents\nmalicious\\hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  assert.throws(
    () => buildAntigravityHookCommand("C:\\My Agents\r\nmalicious\\hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );
  assert.throws(
    () => buildCodexHookCommand("C:\\My Agents\0malicious\\hook.mjs"),
    { message: EXPECTED_ERR_MSG }
  );

  // 3. Dedicated non-reflection security test:
  // Paths containing secret tokens, sensitive directory names, ESC (\x1b), CRLF must NEVER reflect untrusted content into error.message
  const secretSentinel = "SUPER_SECRET_INTERNAL_TOKEN_XYZ_987654";
  const maliciousPathWithSecretAndEsc = `/sensitive/user/path/${secretSentinel}/\x1b[31mred\x1b[0m\r\n$(whoami)/hook.mjs`;

  for (const fn of [buildCodexHookCommand, buildAntigravityHookCommand]) {
    try {
      fn(maliciousPathWithSecretAndEsc);
      assert.fail("Should have thrown on malicious path");
    } catch (err) {
      assert.equal(err.message, EXPECTED_ERR_MSG);
      assert.ok(!err.message.includes(secretSentinel), "Error message must not reflect secret sentinel token");
      assert.ok(!err.message.includes("sensitive/user/path"), "Error message must not reflect user path components");
      assert.ok(!err.message.includes("\x1b"), "Error message must not contain ESC control characters");
      assert.ok(!err.message.includes("\r") && !err.message.includes("\n"), "Error message must not contain CRLF characters");
    }
  }
});

test("JSON hook merging preserves existing user hooks without clobbering", () => {
  // 1. Codex non-destructive merging
  const existingCodex = {
    hooks: {
      PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "test.sh" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "custom-audit.sh" }] }]
    }
  };
  const newPluginCodex = buildCodexHooksConfig("/path/to/scripts/codex-hook.mjs");
  const mergedCodex = mergeCodexHooks(existingCodex, newPluginCodex);

  assert.equal(mergedCodex.hooks.PostToolUse.length, 1);
  assert.equal(mergedCodex.hooks.UserPromptSubmit.length, 2);
  assert.equal(mergedCodex.hooks.UserPromptSubmit[0].hooks[0].command, "custom-audit.sh");
  assert.equal(mergedCodex.hooks.UserPromptSubmit[1].hooks[0].command, 'node "/path/to/scripts/codex-hook.mjs"');

  // Re-merging updates rather than duplicating
  const remerged = mergeCodexHooks(mergedCodex, buildCodexHooksConfig("/new/path/scripts/codex-hook.mjs"));
  assert.equal(remerged.hooks.UserPromptSubmit.length, 2);
  assert.equal(remerged.hooks.UserPromptSubmit[1].hooks[0].command, 'node "/new/path/scripts/codex-hook.mjs"');

  // 2. Antigravity non-destructive merging
  const existingAgy = {
    "my-custom-plugin": { PreInvocation: [{ command: "echo test" }] }
  };
  const newPluginAgy = buildAntigravityHooksConfig("/path/to/scripts/antigravity-hook.mjs");
  const mergedAgy = mergeAntigravityHooks(existingAgy, newPluginAgy);

  assert.ok(mergedAgy["my-custom-plugin"]);
  assert.ok(mergedAgy["obsidian-memory-router"]);
  assert.equal(mergedAgy["obsidian-memory-router"].PreInvocation[0].command, 'node "/path/to/scripts/antigravity-hook.mjs"');
});

test("Codex hook pure functions and prompt extraction", () => {
  assert.equal(extractPromptText({ prompt: "hello" }), "hello");
  assert.equal(
    extractPromptText({
      prompt: [
        { type: "text", text: "part 1" },
        { type: "text", text: "part 2" }
      ]
    }),
    "part 1\npart 2"
  );
  assert.equal(extractPromptText({ message: "msg fallback" }), "msg fallback");
  assert.equal(extractPromptText(null), "");
});

test("Codex hook execution with isolated offline mock: Fast-path recall, auto fail-open, and strict fail-closed", () => {
  const hookScript = join(root, "scripts", "codex-hook.mjs");
  const unreachableEnv = {
    ...process.env,
    OBSIDIAN_MEMORY_SERVICE_FILE: join(tmpdir(), "nonexistent-laya-service.json"),
    OBSIDIAN_MEMORY_ENDPOINT: "http://127.0.0.1:1" // Port 1 is unreachable loopback
  };

  // 1. Fast-path recall (does not need Laya)
  const res1 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ prompt: "回忆一下上次讨论的方案是什么" }),
      encoding: "utf8",
      env: unreachableEnv
    }
  );
  assert.equal(res1.status, 0);
  const parsed1 = JSON.parse(res1.stdout);
  assert.equal(parsed1.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(parsed1.hookSpecificOutput?.additionalContext, /recall recommended/);
  const stderrTrace1 = JSON.parse(res1.stderr.trim().split("\n").pop());
  assert.equal(stderrTrace1.hookExecuted, true);
  assert.equal(stderrTrace1.route, "fast_path");
  assert.equal(stderrTrace1.decision, "recall");
  assert.doesNotMatch(res1.stderr, /回忆一下上次/, "stderr audit trace must be sanitized without prompt text");

  // 2. Auto mode with isolated offline Laya (fail-open)
  const res2 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ prompt: "How do we handle broken symlinks?" }),
      encoding: "utf8",
      env: { ...unreachableEnv, OBSIDIAN_MEMORY_JUDGE_MODE: "auto" }
    }
  );
  assert.equal(res2.status, 0);
  const parsed2 = JSON.parse(res2.stdout);
  assert.equal(parsed2.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.equal(parsed2.hookSpecificOutput?.additionalContext, undefined, "Auto mode must fail-open without injecting");
  const stderrTrace2 = JSON.parse(res2.stderr.trim().split("\n").pop());
  assert.equal(stderrTrace2.hookExecuted, true);
  assert.doesNotMatch(res2.stderr, /broken symlinks/, "stderr audit trace must be sanitized without prompt text");

  // 3. Strict mode with isolated offline Laya (fail-closed)
  const res3 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ prompt: "How do we handle broken symlinks?" }),
      encoding: "utf8",
      env: { ...unreachableEnv, OBSIDIAN_MEMORY_JUDGE_MODE: "strict" }
    }
  );
  assert.equal(res3.status, 0);
  const parsed3 = JSON.parse(res3.stdout);
  assert.equal(parsed3.decision, "block");
  assert.match(parsed3.reason, /strict_mode_/);
  assert.doesNotMatch(parsed3.reason, /ECONNREFUSED|ENOTFOUND|connect/i, "Codex strict reason must be sanitized category without raw error message");
  const stderrTrace3 = JSON.parse(res3.stderr.trim().split("\n").pop());
  assert.equal(stderrTrace3.decision, "block");
  assert.equal(stderrTrace3.hookExecuted, true);
  assert.doesNotMatch(res3.stderr, /broken symlinks/, "stderr audit trace must be sanitized without prompt text");

  // 4. Verification that errors containing secret sentinel / prompt never leak to stdout or stderr
  const sentinelToken = "SUPER_SECRET_TOKEN_SENTINEL_XYZ_987654";
  const sensitivePrompt = "SENSITIVE_PROMPT_CONTENT_MUST_NOT_LEAK";
  const res4 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ prompt: sensitivePrompt }),
      encoding: "utf8",
      env: {
        ...unreachableEnv,
        OBSIDIAN_MEMORY_ENDPOINT: `http://127.0.0.1:1/?token=${sentinelToken}`,
        OBSIDIAN_MEMORY_JUDGE_MODE: "strict"
      }
    }
  );
  assert.equal(res4.status, 0);
  assert.doesNotMatch(res4.stdout, new RegExp(sentinelToken), "stdout must not contain sentinel token");
  assert.doesNotMatch(res4.stdout, new RegExp(sensitivePrompt), "stdout must not contain sensitive prompt");
  assert.doesNotMatch(res4.stderr, new RegExp(sentinelToken), "stderr must not contain sentinel token");
  assert.doesNotMatch(res4.stderr, new RegExp(sensitivePrompt), "stderr must not contain sensitive prompt");
  assert.match(res4.stderr, /strict_mode_(?:evaluation|top_level)_error/);
});

test("Antigravity hook: JSONL parsing, invocation idempotency, atomic cache, and strict unsupported graceful degradation", () => {
  const hookScript = join(root, "scripts", "antigravity-hook.mjs");
  const testDir = mkdtempSync(join(tmpdir(), "agy-hook-test-"));
  const transcriptFile = join(testDir, "transcript.jsonl");

  // Write valid JSONL with various lines
  const jsonlLines = [
    JSON.stringify({ type: "SYSTEM", content: "Agent init" }),
    JSON.stringify({ type: "USER_INPUT", step_index: 0, content: "<USER_REQUEST>回忆一下上次讨论的方案是什么</USER_REQUEST>" }),
    JSON.stringify({ type: "MODEL_RESPONSE", content: "Thinking..." })
  ].join("\n");
  writeFileSync(transcriptFile, jsonlLines, "utf8");

  // 1. Verify pure JSON parsing extraction with line and step info
  const extracted = extractLastUserPrompt(transcriptFile);
  assert.equal(extracted?.text, "回忆一下上次讨论的方案是什么");
  assert.equal(typeof extracted?.lineIndex, "number");

  const unreachableEnv = {
    ...process.env,
    OBSIDIAN_MEMORY_SERVICE_FILE: join(tmpdir(), "nonexistent-laya-service.json"),
    OBSIDIAN_MEMORY_ENDPOINT: "http://127.0.0.1:1"
  };

  const convId = `test-conv-${Date.now()}`;

  // 2. Turn 1 First invocation: injects notice and outputs sanitized stderr trace
  const res1 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        conversationId: convId,
        transcriptPath: transcriptFile,
        invocationNum: 1
      }),
      encoding: "utf8",
      env: unreachableEnv
    }
  );
  assert.equal(res1.status, 0);
  const parsed1 = JSON.parse(res1.stdout);
  assert.ok(parsed1.injectSteps, "First call must inject steps");
  assert.match(parsed1.injectSteps[0].ephemeralMessage, /recall recommended/);
  const stderrTrace1 = JSON.parse(res1.stderr.trim().split("\n").pop());
  assert.equal(stderrTrace1.hookExecuted, true);
  assert.doesNotMatch(res1.stderr, /回忆一下上次/, "stderr audit trace must be sanitized without prompt text");

  // 3. Turn 1 Second invocation (same transcript line): idempotency skip
  const res2 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        conversationId: convId,
        transcriptPath: transcriptFile,
        invocationNum: 1
      }),
      encoding: "utf8",
      env: unreachableEnv
    }
  );
  assert.equal(res2.status, 0);
  const parsed2 = JSON.parse(res2.stdout);
  assert.deepEqual(parsed2, {}, "Second call in same turn must return empty object (idempotency)");

  // 4. Turn 2: Subsequent turn with identical prompt text must execute normally
  const currentTranscript = readFileSync(transcriptFile, "utf8");
  const turn2Line = JSON.stringify({
    type: "USER_INPUT",
    step_index: 2,
    content: "<USER_REQUEST>回忆一下上次讨论的方案是什么</USER_REQUEST>"
  });
  writeFileSync(transcriptFile, `${currentTranscript}\n${turn2Line}`, "utf8");

  const resTurn2 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        conversationId: convId,
        transcriptPath: transcriptFile,
        invocationNum: 2
      }),
      encoding: "utf8",
      env: unreachableEnv
    }
  );
  assert.equal(resTurn2.status, 0);
  const parsedTurn2 = JSON.parse(resTurn2.stdout);
  assert.ok(parsedTurn2.injectSteps, "Subsequent turn with identical prompt must execute and inject steps");

  // 5. Strict mode with isolated offline Laya: PreInvocation has no blocking contract.
  // Must NOT claim blocked=true, must degrade safely to auto fail-open.
  const transcriptOffline = join(testDir, "transcript-offline.jsonl");
  writeFileSync(transcriptOffline, JSON.stringify({ type: "USER_INPUT", content: "How to fix broken symlinks?" }), "utf8");

  const res3 = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        conversationId: `strict-conv-${Date.now()}`,
        transcriptPath: transcriptOffline,
        invocationNum: 1
      }),
      encoding: "utf8",
      env: { ...unreachableEnv, OBSIDIAN_MEMORY_JUDGE_MODE: "strict" }
    }
  );
  assert.equal(res3.status, 0);
  const parsed3 = JSON.parse(res3.stdout);
  assert.equal(parsed3.blocked, undefined, "Antigravity hook must NEVER return blocked=true");
  assert.deepEqual(parsed3, {}, "Antigravity hook must gracefully fail-open when offline in strict mode");
  const stderrTrace3 = JSON.parse(res3.stderr.trim().split("\n").pop());
  assert.equal(stderrTrace3.hostCapability, "antigravity_pre_invocation_strict_unsupported");
  assert.equal(stderrTrace3.strictDegraded, true);
  assert.doesNotMatch(res3.stderr, /broken symlinks/, "stderr trace must be sanitized");
});

test("OpenClaw v2026.9.2: real lifecycle order with official event shapes ({prompt, messages}), optional trigger omitted, observable single Laya evaluation, cache deletion on allow/block, and sanitized blocking", async () => {
  const registeredHandlers = {};
  let layaCalls = 0;
  let shouldBlock = false;

  const mockRouter = {
    evaluateRecall: async (text, options) => {
      layaCalls++;
      if (shouldBlock) {
        return {
          blocked: true,
          reason: "strict_mode_service_unavailable",
          trace: { route: "fallback", decision: "none", reason: "strict_mode_service_unavailable", hookExecuted: true, layaAttempted: true }
        };
      }
      return {
        recallRecommended: true,
        captureRecommended: false,
        blocked: false,
        scope: "project",
        reason: "laya_threshold_met",
        trace: { route: "laya", decision: "recall", reason: "laya_threshold_met", hookExecuted: true, layaAttempted: true }
      };
    },
    dispose() {}
  };

  const inspect = {};
  // Decoupled test factory: production default export remains clean without underscore host API pollution
  const plugin = createOpenClawPlugin({
    routerFactory: () => mockRouter,
    cacheObserver: inspect
  });

  const mockApi = {
    pluginConfig: {
      agentConfigs: {
        "agent-1": { vaultPath: "/path/to/vault" }
      },
      memoryJudge: {
        mode: "strict"
      }
    },
    logger: { debug() {}, info() {} },
    on(event, handler) {
      registeredHandlers[event] = handler;
    }
  };

  plugin.register(mockApi);
  assert.ok(registeredHandlers.before_agent_run, "Must register before_agent_run for strict blocking");
  assert.ok(registeredHandlers.before_prompt_build, "Must register before_prompt_build for context injection");
  assert.ok(inspect.turnDecisionCache, "Must expose turnDecisionCache via cacheObserver");

  // 1. Allow flow with official v2026.9.2 event structures:
  // - before_prompt_build event: { prompt, messages }
  // - before_agent_run event: { prompt, messages, systemPrompt }
  // - context: { runId, sessionId, agentId } (trigger is omitted/undefined)
  layaCalls = 0;
  shouldBlock = false;
  const turn1Context = { runId: "run-turn-1", sessionId: "sess-1", agentId: "agent-1" };
  const promptBuildEvent1 = {
    prompt: "How do we handle broken symlinks?",
    messages: [{ role: "user", content: "How do we handle broken symlinks?" }]
  };
  const agentRunEvent1 = {
    prompt: "How do we handle broken symlinks?",
    messages: [{ role: "user", content: "How do we handle broken symlinks?" }],
    systemPrompt: "You are a helpful assistant"
  };

  // Step A: before_prompt_build runs first
  const promptBuildResult = await registeredHandlers.before_prompt_build(promptBuildEvent1, turn1Context);
  assert.match(promptBuildResult.prependContext, /recall recommended/);
  assert.equal(layaCalls, 1, "before_prompt_build calls Laya evaluation once");
  assert.equal(inspect.turnDecisionCache.size, 1, "Decision must be stored in cache for before_agent_run");

  // Step B: before_agent_run runs second
  const agentRunResult = await registeredHandlers.before_agent_run(agentRunEvent1, turn1Context);
  assert.equal(agentRunResult, undefined, "Allowed turn returns undefined to proceed");
  assert.equal(layaCalls, 1, "Laya evaluation must NOT be called a second time (single call per turn guarantee)");
  assert.equal(inspect.turnDecisionCache.size, 0, "Cache entry must be deleted after consumption on allow");

  // 2. Block flow with official v2026.9.2 structures (Laya called once, cache deleted on consumption, sanitized message & reason)
  layaCalls = 0;
  shouldBlock = true;
  const turn2Context = { runId: "run-turn-2", sessionId: "sess-1", agentId: "agent-1" };
  const promptBuildEvent2 = {
    prompt: "How do we handle broken symlinks?",
    messages: [{ role: "user", content: "How do we handle broken symlinks?" }]
  };
  const agentRunEvent2 = {
    prompt: "How do we handle broken symlinks?",
    messages: [{ role: "user", content: "How do we handle broken symlinks?" }],
    systemPrompt: "You are a helpful assistant"
  };

  // Step A: before_prompt_build runs first
  await registeredHandlers.before_prompt_build(promptBuildEvent2, turn2Context);
  assert.equal(layaCalls, 1, "before_prompt_build calls Laya once");
  assert.equal(inspect.turnDecisionCache.size, 1, "Blocked decision cached");

  // Step B: before_agent_run runs second
  const blockResult = await registeredHandlers.before_agent_run(agentRunEvent2, turn2Context);
  assert.ok(blockResult, "Must return block object");
  assert.equal(blockResult.outcome, "block");
  assert.equal(blockResult.reason, "strict_mode_service_unavailable");
  assert.equal(blockResult.message, "Laya Memory Router strict mode: request blocked by memory policy.");
  assert.doesNotMatch(blockResult.message, /err\.message/, "Message must be sanitized");
  assert.equal(layaCalls, 1, "Laya evaluation must NOT be called a second time on block");
  assert.equal(inspect.turnDecisionCache.size, 0, "Cache entry must be deleted after consumption on block");

  // 3. Cache miss in before_agent_run: Gatekeeper independently evaluates and blocks (fail-closed)
  layaCalls = 0;
  shouldBlock = true;
  const turnMissContext = { runId: "run-miss", sessionId: "sess-miss", agentId: "agent-1" };
  const turnMissEvent = {
    prompt: "How do we handle broken symlinks?",
    messages: [{ role: "user", content: "How do we handle broken symlinks?" }],
    systemPrompt: "You are a helpful assistant"
  };

  const missResult = await registeredHandlers.before_agent_run(turnMissEvent, turnMissContext);
  assert.ok(missResult, "Must return block object on cache miss");
  assert.equal(missResult.outcome, "block");
  assert.equal(layaCalls, 1, "Gatekeeper independently calls Laya on cache miss to maintain fail-closed");

  // 4. Incompatible host version rejection in strict mode
  const mockIncompatibleApi = {
    pluginConfig: {
      agentConfigs: { "agent-1": { vaultPath: "/path/to/vault" } },
      memoryJudge: { mode: "strict" }
    },
    openclawVersion: "2025.12.0",
    logger: { debug() {}, info() {} },
    on() {}
  };
  assert.throws(
    () => plugin.register(mockIncompatibleApi),
    /requires OpenClaw >=2026.9.2/,
    "Incompatible old OpenClaw host must be rejected when strict mode is requested"
  );
});

test("OpenClaw non-user triggers (heartbeat, cron, system) bypass Laya, while missing trigger routes normally", async () => {
  const registeredHandlers = {};
  let layaCalls = 0;

  const mockRouter = {
    evaluateRecall: async () => {
      layaCalls++;
      return { recallRecommended: true, trace: { route: "laya", decision: "recall", hookExecuted: true, layaAttempted: true } };
    },
    dispose() {}
  };

  const plugin = createOpenClawPlugin({ routerFactory: () => mockRouter });
  const mockApi = {
    pluginConfig: {
      agentConfigs: { "agent-1": { vaultPath: "/path/to/vault" } },
      memoryJudge: { mode: "strict" }
    },
    logger: { debug() {}, info() {} },
    on(event, handler) { registeredHandlers[event] = handler; }
  };
  plugin.register(mockApi);

  // 1. trigger === 'heartbeat' -> should NOT call Laya in either hook
  layaCalls = 0;
  const hbBuild = await registeredHandlers.before_prompt_build(
    { prompt: "periodic health ping" },
    { agentId: "agent-1", trigger: "heartbeat", runId: "hb-1" }
  );
  assert.doesNotMatch(hbBuild.prependContext, /recall recommended/, "Heartbeat must not inject recall guidance");
  assert.equal(layaCalls, 0, "Heartbeat must not call Laya in before_prompt_build");

  const hbRun = await registeredHandlers.before_agent_run(
    { prompt: "periodic health ping" },
    { agentId: "agent-1", trigger: "heartbeat", runId: "hb-1" }
  );
  assert.equal(hbRun, undefined, "Heartbeat must pass without blocking");
  assert.equal(layaCalls, 0, "Heartbeat must not call Laya in before_agent_run");

  // 2. trigger === 'cron' -> should NOT call Laya in either hook
  const cronBuild = await registeredHandlers.before_prompt_build(
    { prompt: "scheduled sync" },
    { agentId: "agent-1", trigger: "cron", runId: "cron-1" }
  );
  assert.equal(layaCalls, 0, "Cron must not call Laya");
  const cronRun = await registeredHandlers.before_agent_run(
    { prompt: "scheduled sync" },
    { agentId: "agent-1", trigger: "cron", runId: "cron-1" }
  );
  assert.equal(cronRun, undefined, "Cron must pass without blocking");
  assert.equal(layaCalls, 0, "Cron must not call Laya");

  // 3. trigger missing / undefined -> MUST route normally through Laya!
  layaCalls = 0;
  const normalBuild = await registeredHandlers.before_prompt_build(
    { prompt: "How do we configure database pooling?" },
    { agentId: "agent-1", runId: "user-run-1" } // Note: trigger field is omitted
  );
  assert.match(normalBuild.prependContext, /recall recommended/, "Missing trigger must route normally");
  assert.equal(layaCalls, 1, "Missing trigger must evaluate via Laya");
});

test("OpenClaw currentUserMessage optional enhancement and empty-string precedence", async () => {
  const registeredHandlers = {};
  let evaluatedText = "";

  const mockRouter = {
    evaluateRecall: async (text) => {
      evaluatedText = text;
      return { recallRecommended: true, trace: { route: "laya", decision: "recall", hookExecuted: true, layaAttempted: true } };
    },
    dispose() {}
  };

  const plugin = createOpenClawPlugin({ routerFactory: () => mockRouter });
  const mockApi = {
    pluginConfig: {
      agentConfigs: { "agent-1": { vaultPath: "/path/to/vault" } },
      memoryJudge: { mode: "strict" }
    },
    logger: { debug() {}, info() {} },
    on(event, handler) { registeredHandlers[event] = handler; }
  };
  plugin.register(mockApi);

  // 1. currentUserMessage: "" must NOT fall back to historical prompt
  const emptyRes = await registeredHandlers.before_prompt_build(
    { currentUserMessage: "", prompt: "historical prompt that should NOT be used" },
    { agentId: "agent-1", runId: "run-empty" }
  );
  assert.doesNotMatch(emptyRes.prependContext, /recall recommended/, "Explicit empty currentUserMessage must not trigger recall");

  // 2. currentUserMessage with string text is prioritized
  await registeredHandlers.before_prompt_build(
    { currentUserMessage: "current message text", prompt: "old prompt" },
    { agentId: "agent-1", runId: "run-current" }
  );
  assert.equal(evaluatedText, "current message text", "currentUserMessage string must take precedence over prompt");

  // 3. currentUserMessage with object { text: "..." } is extracted
  await registeredHandlers.before_prompt_build(
    { currentUserMessage: { text: "current message in object" }, prompt: "old prompt" },
    { agentId: "agent-1", runId: "run-obj" }
  );
  assert.equal(evaluatedText, "current message in object", "currentUserMessage.text must take precedence over prompt");
});

test("OpenClaw strictly ignores historical event.messages and does not trigger Laya when prompt/currentUserMessage are absent", async () => {
  const registeredHandlers = {};
  let layaCalls = 0;

  const mockRouter = {
    evaluateRecall: async () => {
      layaCalls++;
      return { recallRecommended: true, trace: { route: "laya", decision: "recall", hookExecuted: true, layaAttempted: true } };
    },
    dispose() {}
  };

  const plugin = createOpenClawPlugin({ routerFactory: () => mockRouter });
  const mockApi = {
    pluginConfig: {
      agentConfigs: { "agent-1": { vaultPath: "/path/to/vault" } },
      memoryJudge: { mode: "strict" }
    },
    logger: { debug() {}, info() {} },
    on(event, handler) { registeredHandlers[event] = handler; }
  };
  plugin.register(mockApi);

  // Even if event.messages contains an array of historical user/assistant turns,
  // when prompt and currentUserMessage are missing/empty, it must NOT inspect messages or call Laya!
  const res = await registeredHandlers.before_prompt_build(
    {
      messages: [
        { role: "user", content: "Remember to check previous schema migrations" },
        { role: "assistant", content: "Understood." }
      ]
    },
    { agentId: "agent-1", runId: "historical-run" }
  );

  assert.equal(layaCalls, 0, "Laya must NOT be triggered by historical messages when prompt is absent");
  assert.ok(res.prependContext.includes("[Obsidian Memory]"));
  assert.ok(!res.prependContext.includes("[Laya Memory Judge]"));
  assert.doesNotMatch(res.prependContext, /recall recommended/);

  // Similarly in before_agent_run, must pass without blocking or calling Laya
  const runRes = await registeredHandlers.before_agent_run(
    {
      messages: [
        { role: "user", content: "Remember to check previous schema migrations" }
      ]
    },
    { agentId: "agent-1", runId: "historical-run" }
  );
  assert.equal(runRes, undefined, "before_agent_run must return undefined without calling Laya");
  assert.equal(layaCalls, 0, "before_agent_run must NOT call Laya on absent prompt");
});

test("openclaw.plugin.json manifest consistency: schema default and uiHints match", () => {
  const manifestPath = join(root, "openclaw.plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const schemaDefault = manifest.configSchema.properties.memoryJudge.properties.mode.default;
  assert.equal(schemaDefault, "auto", "configSchema memoryJudge.mode default must be 'auto'");
  assert.match(
    manifest.uiHints.memoryJudge.label,
    /default mode: auto/,
    "uiHints.memoryJudge.label must state default mode: auto matching schema"
  );
});

test("openclaw.plugin.json memoryJudge schema accepts every field lib/config.js accepts, with matching defaults", () => {
  const manifest = JSON.parse(readFileSync(join(root, "openclaw.plugin.json"), "utf8"));
  const props = manifest.configSchema.properties.memoryJudge.properties;
  assert.deepEqual(Object.keys(props).sort(), Object.keys(DEFAULT_MEMORY_JUDGE).sort());
  for (const [key, value] of Object.entries(DEFAULT_MEMORY_JUDGE)) {
    if (key === "endpoint" || key === "serviceFile") continue; // null / home-dependent defaults
    assert.equal(props[key].default, value, `schema default for ${key} must match DEFAULT_MEMORY_JUDGE`);
  }
  // Every accepted value must also parse successfully.
  assert.doesNotThrow(() => parseMemoryJudgeConfig({ proactiveCapture: false, captureThreshold: 0.8 }));
});

test("npm pack dry run excludes __pycache__ and *.pyc files", () => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("npm_"))
  );
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv
  });
  const parsed = JSON.parse(out);
  const files = parsed[0]?.files || [];
  const filePaths = files.map(f => f.path);

  const pycFiles = filePaths.filter(p => p.includes("__pycache__") || p.endsWith(".pyc"));
  assert.deepEqual(pycFiles, [], `npm pack must not contain any pycache or pyc files, found: ${pycFiles.join(", ")}`);
});

test("Hermes pre_llm_call: Fast-path context injection, auto fail-open, and strict unsupported graceful degradation", () => {
  const python = findPython();
  const script = String.raw`
import importlib.util, json, sys, os
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("obsidian_memory_plugin", root / "__init__.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Ctx:
    def __init__(self, mode="auto"):
        self.mode = mode
        self.hooks = {}
    def get_config(self, key, default=None):
        if key == "memory_router_mode": return self.mode
        return default
    def register_skill(self, *args, **kwargs): pass
    def register_system_prompt_section(self, *args, **kwargs): pass
    def register_hook(self, name, cb): self.hooks[name] = cb

# 1. Fast-path recall
ctx_auto = Ctx("auto")
module.register(ctx_auto)
r1 = ctx_auto.hooks["pre_llm_call"](user_message="回忆一下上次讨论的方案是什么")

# 2. Auto mode greeting (no memory needed)
r2 = ctx_auto.hooks["pre_llm_call"](user_message="hello")

# 3. Strict mode: pre_llm_call has no abort API in Hermes. Must gracefully degrade to auto fail-open!
# Isolate offline by setting environment
os.environ["OBSIDIAN_MEMORY_ENDPOINT"] = "http://127.0.0.1:1"
os.environ["OBSIDIAN_MEMORY_SERVICE_FILE"] = "/tmp/nonexistent-service.json"
ctx_strict = Ctx("strict")
module.register(ctx_strict)
r3 = ctx_strict.hooks["pre_llm_call"](user_message="How do we handle broken symlinks?")

print(json.dumps({
    "recall_context": r1.get("context", ""),
    "greeting": r2,
    "strict_result": r3
}))
`;

  const output = execFileSync(
    python.command,
    [...python.args, "-c", script, root],
    { encoding: "utf8" }
  );
  const res = JSON.parse(output.trim().split("\n").pop());
  assert.match(res.recall_context, /recall recommended/);
  // Greetings are confidently self-contained: Hermes now gets an explicit "memory not needed" hint.
  assert.match(res.greeting.context, /not needed for this turn/);
  assert.deepEqual(res.strict_result, {}, "Hermes strict mode must gracefully degrade to auto fail-open when offline");
});

test("hookExecuted is false in core router/CLI, and set to true only by host hook adapters", async () => {
  const router = new MemoryRouter(parseMemoryJudgeConfig({ mode: "auto" }), { useCache: false });
  try {
    const decision = await router.evaluateRecall("回忆一下上次讨论的方案是什么");
    assert.equal(
      decision.trace.hookExecuted,
      false,
      "Core router must return hookExecuted: false because it is not a host hook"
    );
  } finally {
    router.dispose();
  }
});

test("Codex strict block reason is fixed text plus a sanitized category only", () => {
  assert.equal(strictBlockReason("strict_mode_laya_unavailable"), "Laya memory judge unavailable in strict mode (strict_mode_laya_unavailable).");
  assert.equal(strictBlockReason("connect ECONNREFUSED 127.0.0.1:1"), "Laya memory judge unavailable in strict mode (strict_mode_evaluation_error).");
  assert.equal(strictBlockReason(undefined), "Laya memory judge unavailable in strict mode (strict_mode_evaluation_error).");
});

test("action notice is shared and fallbacks are never injected", () => {
  const recall = { recallRecommended: true, scope: "global" };
  assert.equal(buildLayaActionNotice(recall), buildLayaNotice(recall));
  const fallback = { recallRecommended: false, captureRecommended: false, trace: { route: "fallback", reason: "laya_fallback" } };
  assert.equal(buildLayaActionNotice(fallback), null);
  assert.equal(buildLayaNotice(fallback), null, "fallbacks are not injected into the prompt");
});

test("router fallback results keep hookExecuted false and block only in strict mode", async () => {
  const missing = join(tmpdir(), "obsidian-memory-missing-service.json");
  for (const mode of ["auto", "strict"]) {
    const router = new MemoryRouter(parseMemoryJudgeConfig({ mode, serviceFile: missing }), { timers: { setInterval: null, clearInterval() {}, setTimeout, clearTimeout } });
    const res = await router.evaluateRecall("这个接口的分页参数应该怎么设计比较好");
    router.dispose();
    assert.equal(res.trace.hookExecuted, false);
    assert.equal(res.trace.route, "fallback");
    assert.equal(res.blocked, mode === "strict");
    assert.equal(res.reason, mode === "strict" ? "strict_mode_laya_unavailable" : "no_trusted_service");
    assert.equal(res.trace.reason, res.reason);
  }
});

test("memoryActionFor: only confident verdicts skip; uncertain, fallback and blocked keep the default workflow", async () => {
  const { memoryActionFor } = await import("../lib/prompt.js");
  const laya = (score, extra = {}) => ({ score, trace: { route: "laya" }, ...extra });
  assert.equal(memoryActionFor(laya(0.1), 0.35), "skip");
  assert.equal(memoryActionFor(laya(0.4), 0.35), "default");
  assert.equal(memoryActionFor(laya(0.9, { recallRecommended: true }), 0.35), "recall");
  assert.equal(memoryActionFor({ reason: "trivial_greeting", trace: { route: "fast_path" } }), "skip");
  assert.equal(memoryActionFor({ reason: "no_trusted_service", trace: { route: "fallback" } }), "default");
  assert.equal(memoryActionFor({ blocked: true, score: 0.01, trace: { route: "laya" } }), "default");
  assert.equal(memoryActionFor(null), "default");
});

test("OpenClaw replaces the full workflow with a compact skip block only when Laya is confident", async () => {
  const { buildGuidance, SKIP_NOTICE } = await import("../lib/prompt.js");
  const cfg = { vaultPath: "/v", cliPath: "obsidian" };
  const full = buildGuidance(cfg);
  const skip = buildGuidance(cfg, { score: 0.05, trace: { route: "laya" } });
  const uncertain = buildGuidance(cfg, { score: 0.45, trace: { route: "laya" } });
  assert.ok(skip.includes(SKIP_NOTICE) && skip.includes("[End Obsidian Memory]") && skip.includes("/v"));
  assert.ok(!skip.includes("SKILL.md") && !skip.includes("For code tasks"));
  assert.ok(skip.length < full.length / 2, `skip block should be much shorter (${skip.length} vs ${full.length})`);
  assert.equal(uncertain, full);
});

test("skipThreshold is configurable and never exceeds recallThreshold", () => {
  assert.equal(parseMemoryJudgeConfig({}).skipThreshold, 0.35);
  assert.equal(parseMemoryJudgeConfig({ skipThreshold: 0.2 }).skipThreshold, 0.2);
  assert.equal(parseMemoryJudgeConfig({ recallThreshold: 0.3, skipThreshold: 0.4 }).skipThreshold, 0.3);
});
