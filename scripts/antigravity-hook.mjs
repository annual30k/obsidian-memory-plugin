#!/usr/bin/env node
/**
 * Antigravity PreInvocation native hook for obsidian-memory-plugin.
 *
 * Runs synchronously before the model is called in Antigravity.
 * Performs turn-level idempotency deduplication by extracting the latest USER_INPUT line position/step identity
 * from transcript.jsonl. Different turns with identical prompts execute normally.
 * Per-conversation cache files with atomic write (renameSync) and 1h TTL cleanup prevent concurrency conflicts.
 * In auto mode: Fast-Path -> Laya (if needed) -> injects ephemeralMessage; fails open on error.
 * In strict mode: PreInvocation has no native blocking contract; explicitly marks strict_unsupported
 * and gracefully degrades to auto fail-open.
 * Outputs sanitized audit trace to stderr, keeping stdout strictly formatted for host JSON contracts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_MEMORY_JUDGE, parseMemoryJudgeConfig } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";
import { buildLayaNotice } from "../lib/prompt.js";
import { resolveVaultPath } from "../lib/memory-router/vault-index.js";
import { enqueueCapture } from "../lib/memory-router/capture-queue.js";
import { stateFile } from "../lib/memory-router/paths.js";

const TURN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const unwrapRequest = (text) => {
  const match = String(text).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (match ? match[1] : String(text)).trim();
};

/**
 * The turn before the current one in an Antigravity transcript: its user request and the model's final
 * text (the last PLANNER_RESPONSE with content before the current USER_INPUT). Antigravity has no
 * end-of-turn hook, so the previous turn is queued for the session digest when the next one starts.
 */
export function previousExchange(transcriptPath, currentLineIndex) {
  if (!transcriptPath || !existsSync(transcriptPath) || !Number.isInteger(currentLineIndex)) return null;
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    let reply = null;
    for (let i = Math.min(currentLineIndex, lines.length) - 1; i >= 0; i--) {
      let parsed;
      try { parsed = JSON.parse(lines[i]); } catch { continue; }
      if (!parsed || typeof parsed !== "object") continue;
      if (!reply && parsed.type === "PLANNER_RESPONSE" && typeof parsed.content === "string" && parsed.content.trim()) {
        reply = parsed.content;
      } else if (parsed.type === "USER_INPUT" && typeof parsed.content === "string") {
        return reply ? { prompt: unwrapRequest(parsed.content), reply } : null;
      }
    }
  } catch {}
  return null;
}

export function extractLastUserPrompt(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const content = readFileSync(transcriptPath, "utf8");
    const lines = content.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          if (parsed.type === "USER_INPUT" && typeof parsed.content === "string") {
            let text = parsed.content;
            const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (match) {
              text = match[1];
            }
            return {
              text: text.trim(),
              lineIndex: i,
              stepIndex: parsed.step_index ?? parsed.stepIndex ?? null
            };
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {}
  return null;
}

export function deriveTurnId({ extracted, invocationNum, userPrompt }) {
  if (extracted && typeof extracted.lineIndex === "number") {
    const step = extracted.stepIndex ?? "none";
    return `line:${extracted.lineIndex}:step:${step}`;
  }
  if (invocationNum !== null && invocationNum !== undefined) {
    return `inv:${invocationNum}`;
  }
  return `prompt:${createHash("sha256").update(userPrompt || "").digest("hex")}`;
}

export function getConversationTurnCachePath(conversationId) {
  const safeHash = createHash("sha256").update(conversationId || "default").digest("hex").slice(0, 32);
  return stateFile(`antigravity-turns/${safeHash}.json`);
}

export function readConversationTurnCache(conversationId) {
  const cachePath = getConversationTurnCachePath(conversationId);
  if (!existsSync(cachePath)) return null;
  try {
    const raw = readFileSync(cachePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const now = Date.now();
    if (data.timestamp && (now - data.timestamp) > TURN_CACHE_TTL_MS) {
      try { unlinkSync(cachePath); } catch {}
      return null;
    }
    const validTurns = {};
    if (data.turns && typeof data.turns === "object") {
      for (const [tid, ts] of Object.entries(data.turns)) {
        if (typeof ts === "number" && (now - ts) < TURN_CACHE_TTL_MS) {
          validTurns[tid] = ts;
        }
      }
    }
    data.turns = validTurns;
    return data;
  } catch {
    return null;
  }
}

export function writeConversationTurnCacheAtomic(conversationId, cache) {
  const cachePath = getConversationTurnCachePath(conversationId);
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, cachePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {}
  }
}

export function emitAuditTrace(trace, { hostCapability = "antigravity_pre_invocation", strictDegraded = false } = {}) {
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
  let mode = DEFAULT_MEMORY_JUDGE.mode;
  if (process.env.OBSIDIAN_MEMORY_JUDGE_MODE) {
    const envMode = process.env.OBSIDIAN_MEMORY_JUDGE_MODE.trim();
    if (["off", "auto", "strict", "manual"].includes(envMode)) {
      mode = envMode;
    }
  }

  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    console.log(JSON.stringify({}));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const conversationId = payload?.conversationId || "";
  const transcriptPath = payload?.transcriptPath || "";
  const invocationNum = payload?.invocationNum ?? payload?.stepIndex ?? null;
  const extracted = extractLastUserPrompt(transcriptPath);
  const userPrompt = (extracted ? extracted.text : "")
    || (typeof payload?.prompt === "string" && payload.prompt.trim())
    || (typeof payload?.lastUserPrompt === "string" && payload.lastUserPrompt.trim())
    || (typeof payload?.userPrompt === "string" && payload.userPrompt.trim());

  if (!userPrompt) {
    console.log(JSON.stringify({}));
    return;
  }

  // mode "off": behave as if the router did not exist. No turn records, no capture queue, no hint.
  if (mode === "off") {
    console.log(JSON.stringify({}));
    return;
  }

  const turnId = deriveTurnId({ extracted, invocationNum, userPrompt });
  const turnCache = readConversationTurnCache(conversationId) || {
    conversationId,
    timestamp: Date.now(),
    turns: {}
  };

  // Idempotency check: if this specific turn was already executed, skip duplicate evaluation
  if (turnCache.turns && turnCache.turns[turnId]) {
    console.log(JSON.stringify({}));
    return;
  }

  const isStrict = mode === "strict";
  let hostCapability = "antigravity_pre_invocation";
  if (isStrict) {
    hostCapability = "antigravity_pre_invocation_strict_unsupported";
    // PreInvocation does not support blocking model invocation.
    // Degrade safely to auto fail-open and never claim blocked=true.
    mode = "auto";
  }

  const judgeConfigInput = { mode };
  if (process.env.OBSIDIAN_MEMORY_ENDPOINT) {
    judgeConfigInput.endpoint = process.env.OBSIDIAN_MEMORY_ENDPOINT.trim();
  }
  if (process.env.OBSIDIAN_MEMORY_SERVICE_FILE) {
    judgeConfigInput.serviceFile = process.env.OBSIDIAN_MEMORY_SERVICE_FILE.trim();
  }

  const autoCapture = process.env.OBSIDIAN_MEMORY_AUTO_CAPTURE?.trim();
  if (["digest", "revise", "remind", "off"].includes(autoCapture)) judgeConfigInput.autoCapture = autoCapture;
  const judgeConfig = parseMemoryJudgeConfig(judgeConfigInput);
  const router = createMemoryRouter(judgeConfig, { useCache: true });

  // "digest": queue the previous (finished) turn of this conversation for the session digest.
  const vaultPath = resolveVaultPath();
  if (judgeConfig.autoCapture === "digest" && judgeConfig.proactiveCapture !== false && conversationId && extracted) {
    const previous = previousExchange(transcriptPath, extracted.lineIndex);
    if (previous) {
      const cwd = [payload?.cwd, payload?.workspaceRoot, Array.isArray(payload?.workspaceRoots) ? payload.workspaceRoots[0] : null]
        .find((v) => typeof v === "string" && v) || process.cwd();
      enqueueCapture("turn", previous, { host: "antigravity", sessionKey: conversationId, vaultPath, cwd });
    }
  }

  try {
    const workspace = [payload?.cwd, payload?.workspaceRoot, Array.isArray(payload?.workspaceRoots) ? payload.workspaceRoots[0] : null]
      .find((v) => typeof v === "string" && v) || process.cwd();
    const decision = await router.evaluateRecall(userPrompt, null, {
      host: "antigravity",
      sessionKey: conversationId || null,
      cwd: workspace,
      vaultPath
    });
    if (decision.trace) {
      decision.trace.hookExecuted = true;
    }

    emitAuditTrace(decision.trace, { hostCapability, strictDegraded: isStrict });

    // Record turn to per-conversation cache atomically on evaluation completion
    turnCache.turns[turnId] = Date.now();
    turnCache.timestamp = Date.now();
    writeConversationTurnCacheAtomic(conversationId, turnCache);

    const notice = buildLayaNotice(decision);
    if (notice) {
      console.log(JSON.stringify({
        injectSteps: [
          {
            ephemeralMessage: notice
          }
        ]
      }));
    } else {
      console.log(JSON.stringify({}));
    }
  } catch {
    emitAuditTrace({ route: "fallback", decision: "none", reason: "evaluation_error", layaAttempted: false }, { hostCapability, strictDegraded: isStrict });
    console.log(JSON.stringify({}));
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
  main().catch(() => {
    console.log(JSON.stringify({}));
    process.exit(0);
  });
}
