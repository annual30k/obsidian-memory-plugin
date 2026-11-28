#!/usr/bin/env node
/**
 * UserPromptSubmit native hook for obsidian-memory-plugin, shared by Codex and Claude Code (both load
 * hooks/hooks.json and speak the same JSON; lib/memory-router/hook-host.js tells them apart).
 *
 * Runs synchronously before a prompt is submitted to the model.
 * In auto mode: Fast-Path -> Laya (if needed) -> injects additionalContext; fails open on error.
 * In strict mode: blocks prompt submission if Laya evaluation fails or is unavailable.
 * Outputs sanitized audit trace to stderr, keeping stdout strictly formatted for host JSON contracts.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryJudgeFromEnv, memoryJudgeModeFromEnv } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import { buildLayaNotice } from "../lib/prompt.js";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { hookHost } from "../lib/memory-router/hook-host.js";

// Fixed, user-facing block text; only the sanitized reason category is appended (never raw errors).
export function strictBlockReason(category) {
  const safe = typeof category === "string" && /^[a-z_]{1,64}$/.test(category) ? category : "strict_mode_evaluation_error";
  return `Laya memory judge unavailable in strict mode (${safe}).`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function extractPromptText(payload) {
  if (!payload) return "";
  if (typeof payload.prompt === "string") {
    return payload.prompt.trim();
  }
  if (Array.isArray(payload.prompt)) {
    return payload.prompt
      .filter(item => item && (item.type === "text" || typeof item.text === "string"))
      .map(item => (typeof item === "string" ? item : (item.text || "")))
      .join("\n")
      .trim();
  }
  if (typeof payload.message === "string") return payload.message.trim();
  if (typeof payload.text === "string") return payload.text.trim();
  return "";
}

export function emitAuditTrace(trace, { hostCapability = "codex_user_prompt_submit", strictDegraded = false } = {}) {
  const sanitized = {
    route: trace?.route ?? "unknown",
    decision: trace?.decision ?? "none",
    reason: trace?.reason ?? "none",
    hookExecuted: true,
    layaAttempted: Boolean(trace?.layaAttempted),
    hostCapability,
    strictDegraded: Boolean(strictDegraded)
  };
  try {
    process.stderr.write(JSON.stringify(sanitized) + "\n");
  } catch {}
}

async function main() {
  const judgeConfig = memoryJudgeFromEnv(process.env);
  const mode = judgeConfig.mode;

  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
    return;
  }

  const promptText = extractPromptText(payload);
  if (!promptText) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
    return;
  }

  const router = createMemoryRouter(judgeConfig, { useCache: true });
  const host = hookHost(payload);
  const audit = (t, extra = {}) => emitAuditTrace(t, { hostCapability: `${host}_user_prompt_submit`, ...extra });

  try {
    const decision = await router.evaluateRecall(promptText, null, {
      host,
      sessionKey: typeof payload.session_id === "string" ? payload.session_id : null,
      cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd(),
      vaultPath: resolveVaultPath()
    });
    if (decision.trace) {
      decision.trace.hookExecuted = true;
    }

    if (decision.blocked) {
      audit({
        ...(decision.trace || {}),
        decision: "block",
        reason: decision.reason
      });
      console.log(JSON.stringify({
        decision: "block",
        reason: strictBlockReason(decision.reason)
      }));
      return;
    }

    audit(decision.trace);

    const notice = buildLayaNotice(decision);
    if (notice) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: notice
        }
      }));
    } else {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit"
        }
      }));
    }
  } catch (_err) {
    process.stderr.write("[codex-hook] Evaluation error: evaluation_failed\n");
    audit({
      route: "fallback",
      decision: mode === "strict" ? "block" : "none",
      reason: mode === "strict" ? "strict_mode_evaluation_error" : "evaluation_error",
      layaAttempted: false
    });
    if (mode === "strict") {
      console.log(JSON.stringify({
        decision: "block",
        reason: strictBlockReason("strict_mode_evaluation_error")
      }));
    } else {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit"
        }
      }));
    }
  } finally {
    router.dispose();
  }
}

const isEntrypoint = process.argv[1] && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((_err) => {
    process.stderr.write("[codex-hook] Top-level error: process_failure\n");
    const mode = memoryJudgeModeFromEnv(process.env);
    emitAuditTrace({
      route: "fallback",
      decision: mode === "strict" ? "block" : "none",
      reason: mode === "strict" ? "strict_mode_top_level_error" : "top_level_error",
      layaAttempted: false
    });
    if (mode === "strict") {
      console.log(JSON.stringify({
        decision: "block",
        reason: strictBlockReason("strict_mode_top_level_error")
      }));
    } else {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit" } }));
    }
    process.exit(0);
  });
}
