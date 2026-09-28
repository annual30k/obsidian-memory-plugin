#!/usr/bin/env node
/**
 * Codex Stop hook: runs when the agent is about to finish a turn. Two checks, in order:
 *
 *  1. An explicit "remember this" request whose turn produced no inbox candidate: ask for one more pass
 *     ({"decision": "block", "reason": ...}). Once per request; turn-context.js marks it.
 *  2. Automatic capture (memoryJudge.autoCapture, env OBSIDIAN_MEMORY_AUTO_CAPTURE):
 *     "digest" (default) queues this turn's request and final reply for the background session digest
 *     and returns at once: no extra model pass. "revise" asks for one more pass when the reply looks
 *     like a durable conclusion (Laya is asked only when the cheap features cannot decide); "remind"
 *     records it for a reminder next turn; "off" does nothing. At most one extra pass per turn in all.
 *     The reply comes from `last_assistant_message` when the host provides it, else from the last
 *     assistant message in `transcript_path`.
 *
 * Never when stop_hook_active is set (no loops). Any error exits silently: finishing a turn is never
 * blocked for a reason the user did not ask for.
 */
import { realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pendingCaptureEnforcement, judgeTurnEndCapture, turnEndNeedsScore, enqueueTurnEnd } from "../lib/memory-router/turn-context.js";
import { DEFAULT_MEMORY_JUDGE, parseMemoryJudgeConfig } from "../lib/config.js";
import { createMemoryRouter } from "../lib/memory-router/router.js";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Last assistant message of a Codex rollout transcript (JSONL), or null. Reads at most the last 2 MB. */
export function lastAssistantMessageFromTranscript(transcriptPath) {
  try {
    if (typeof transcriptPath !== "string" || !transcriptPath) return null;
    const raw = readFileSync(transcriptPath, "utf8");
    const tail = raw.length > 2_000_000 ? raw.slice(raw.length - 2_000_000) : raw;
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const payload = event?.payload ?? {};
      if (event?.type === "event_msg" && payload.type === "task_complete" && typeof payload.last_agent_message === "string") return payload.last_agent_message;
      if (event?.type === "response_item" && payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
        const text = payload.content.filter((c) => c && typeof c.text === "string").map((c) => c.text).join("\n");
        if (text.trim()) return text;
      }
    }
  } catch {}
  return null;
}

export function judgeConfigFromEnv(env = process.env) {
  const input = {};
  const mode = env.OBSIDIAN_MEMORY_JUDGE_MODE?.trim();
  if (["off", "auto", "strict", "manual"].includes(mode)) input.mode = mode;
  if (env.OBSIDIAN_MEMORY_ENDPOINT) input.endpoint = env.OBSIDIAN_MEMORY_ENDPOINT.trim();
  if (env.OBSIDIAN_MEMORY_SERVICE_FILE) input.serviceFile = env.OBSIDIAN_MEMORY_SERVICE_FILE.trim();
  const auto = env.OBSIDIAN_MEMORY_AUTO_CAPTURE?.trim();
  if (["digest", "revise", "remind", "off"].includes(auto)) input.autoCapture = auto;
  return parseMemoryJudgeConfig(input);
}

/**
 * options: { sessionStatePath, now, config, layaScore (number|null|undefined), readTranscript }.
 * `layaScore` undefined means "not looked up"; the script passes the router's score when it has one.
 */
export function decideStop(payload, options = {}) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.stop_hook_active === true || payload.stopHookActive === true) return null;
  // mode "off": no router, so nothing to enforce and nothing to queue (as before the router existed).
  if ((options.config ?? DEFAULT_MEMORY_JUDGE).mode === "off") return null;
  const sessionKey = typeof payload.session_id === "string" ? payload.session_id : null;
  if (!sessionKey) return null;
  const stateOpts = { ...(options.sessionStatePath ? { sessionStatePath: options.sessionStatePath } : {}), ...(options.now ? { now: options.now } : {}) };
  const pending = pendingCaptureEnforcement({ host: "codex", sessionKey, ...stateOpts });
  if (pending) return { decision: "block", reason: pending.instruction };
  const config = options.config ?? DEFAULT_MEMORY_JUDGE;
  if (config.proactiveCapture === false || config.autoCapture === "off") return null;
  const reply = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message
    : (options.readTranscript ?? lastAssistantMessageFromTranscript)(payload.transcript_path);
  if (!reply) return null;
  if (config.autoCapture === "digest") {
    enqueueTurnEnd({ host: "codex", sessionKey, assistantText: reply, ...stateOpts,
      ...(options.queueDir ? { queueDir: options.queueDir } : {}), ...(options.scheduleDigest ? { scheduleDigest: options.scheduleDigest } : {}) });
    return null;
  }
  const verdict = judgeTurnEndCapture({ host: "codex", sessionKey, assistantText: reply, mode: config.autoCapture, layaScore: options.layaScore ?? null, ...stateOpts });
  if (!verdict || config.autoCapture !== "revise") return null;
  return { decision: "block", reason: verdict.instruction };
}

export async function main() {
  let payload = null;
  try {
    const raw = await readStdin();
    payload = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return;
  }
  if (!payload || payload.stop_hook_active === true) return;
  const config = judgeConfigFromEnv();
  let layaScore = null;
  let router = null;
  try {
    const reply = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : lastAssistantMessageFromTranscript(payload.transcript_path);
    const sessionKey = typeof payload.session_id === "string" ? payload.session_id : null;
    // No router (service discovery, health handshake, model call) unless the cheap features cannot decide.
    if (reply && config.mode !== "off" && config.proactiveCapture !== false && config.autoCapture !== "digest" &&
        turnEndNeedsScore({ host: "codex", sessionKey, assistantText: reply, mode: config.autoCapture })) {
      router = createMemoryRouter(config, { useCache: true });
      layaScore = await router.captureScoreFor(reply);
    }
  } catch {
    layaScore = null;
  } finally {
    router?.dispose?.();
  }
  const out = decideStop(payload, { config, layaScore });
  if (out) console.log(JSON.stringify(out));
}

const isEntrypoint = process.argv[1] && (() => {
  try { return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (isEntrypoint) {
  main().catch(() => {});
}
