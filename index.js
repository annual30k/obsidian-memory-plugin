import { DEFAULT_MEMORY_JUDGE, parseConfigs } from "./lib/config.js";
import { buildGuidance, buildLayaNotice, memoryActionFor } from "./lib/prompt.js";
import { pendingCaptureEnforcement, judgeTurnEndCapture, turnEndNeedsScore, enqueueTurnEnd } from "./lib/memory-router/turn-context.js";

function messageText(message) {
  const m = message && typeof message === "object" && message.message && typeof message.message === "object" ? message.message : message;
  if (!m || typeof m !== "object") return { role: null, text: "", error: false };
  const content = m.content ?? m.text ?? "";
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((p) => (typeof p === "string" ? p : (typeof p?.text === "string" ? p.text : ""))).filter(Boolean).join("\n")
    : "";
  const error = m.stopReason === "error" || m.stop_reason === "error" || (typeof m.errorMessage === "string" && m.errorMessage !== "");
  return { role: typeof m.role === "string" ? m.role : null, text, error };
}

/**
 * The last user request and the final assistant text of a finished OpenClaw run (agent_end messages).
 * Only the run's own final message counts: when the last assistant message is empty or an error (a failed
 * model call), nothing is returned instead of reaching back into older history.
 */
export function lastExchange(messages) {
  if (!Array.isArray(messages)) return { prompt: "", reply: "" };
  let reply = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, text, error } = messageText(messages[i]);
    if (reply === null) {
      if (role !== "assistant") continue;
      if (error || !text.trim()) return { prompt: "", reply: "" };
      reply = text;
    } else if (role === "user" && text.trim()) {
      return { prompt: text, reply };
    }
  }
  return { prompt: "", reply: reply ?? "" };
}
import { createMemoryRouter } from "./lib/memory-router/router.js";
import { evaluateFastPath } from "./lib/memory-router/fast-path.js";
import { enrichDecision } from "./lib/memory-router/turn-context.js";

const CACHE_TTL_MS = 30000;

function checkOpenClawStrictCompatibility(api) {
  // Package-level manifest compat (package.json openclaw.compat.minGatewayVersion) is the primary gateway contract.
  // Runtime check acts as a secondary defense when runtime version metadata is available.
  const ver = api?.openclawVersion ?? api?.gatewayVersion ?? api?.version ?? process.env.OPENCLAW_VERSION;
  if (!ver) {
    api?.logger?.debug?.(
      "[Obsidian Memory] Host runtime version not exposed by api; relying on package manifest compatibility (openclaw.compat >=2026.9.2)."
    );
    return true;
  }
  const parts = String(ver).split(".").map(p => parseInt(p, 10));
  if (!isNaN(parts[0])) {
    if (parts[0] < 2026 || (parts[0] === 2026 && (parts[1] < 9 || (parts[1] === 9 && (parts[2] || 0) < 2)))) {
      return false;
    }
  }
  return true;
}

function getTurnKey(event, context, text) {
  // Priority 1: context.runId (the official stable execution turn ID across hooks in OpenClaw v2026.9.2)
  if (context?.runId) {
    return `run:${context.runId}`;
  }
  // Priority 2: event-level message/turn ID
  const eventMsgId = event?.currentUserMessageId ?? event?.turnId ?? event?.messageId;
  if (eventMsgId) {
    return `msg:${eventMsgId}`;
  }
  // Priority 3: session/agent fallback
  const sessionOrAgent = context?.sessionKey ?? context?.sessionId ?? context?.agentId ?? "default";
  return `fallback:${sessionOrAgent}:${text.trim()}`;
}

function isExplicitNonUserInput(context) {
  const trigger = context?.trigger;
  // trigger is an optional field on PluginHookAgentContext.
  // Only skip if explicitly identified as non-user (e.g. heartbeat, cron, system)
  if (trigger && trigger !== "user") {
    return true;
  }
  return false;
}

function extractUserPrompt(event) {
  try {
    // 1. Optional enhancement: event.currentUserMessage (or currentUserMessage.text)
    if (typeof event?.currentUserMessage === "string") {
      return event.currentUserMessage;
    }
    if (event?.currentUserMessage && typeof event.currentUserMessage.text === "string") {
      return event.currentUserMessage.text;
    }
    // 2. Official v2026.9.2 primary contract: event.prompt
    if (typeof event?.prompt === "string") {
      return event.prompt;
    }
  } catch {
    return "";
  }
  // When both currentUserMessage and event.prompt are missing or empty, return empty string.
  // Strictly do NOT inspect historical event.messages, event.message, or event.input.
  return "";
}

export function createOpenClawPlugin(options = {}) {
  const routerFactory = options.routerFactory ?? createMemoryRouter;
  const cacheObserver = options.cacheObserver ?? null;

  return {
    id: "obsidian-memory-plugin",
    name: "Obsidian Memory",
    description: "The memory skill, using the host's existing Obsidian skills.",
    register(api) {
      const configs = parseConfigs(api.pluginConfig ?? {});
      if (configs.size === 0) {
        api.logger?.info?.("Obsidian Memory: configure agentId/vaultPath or agentConfigs to enable guidance.");
        return;
      }
      const memoryJudge = configs.memoryJudge ?? DEFAULT_MEMORY_JUDGE;

      if (memoryJudge.mode === "strict") {
        if (!checkOpenClawStrictCompatibility(api)) {
          throw new Error(
            "Obsidian Memory: strict mode requires OpenClaw >=2026.9.2 with before_agent_run fail-closed contract; incompatible host rejected."
          );
        }
        api.logger?.info?.(
          "[Obsidian Memory] Strict mode enabled. Note: before_agent_run fail-closed blocking is strictly enforced in official OpenClaw embedded/CLI runner. Other runners (e.g. Codex/Copilot runner) only guarantee context injection or graceful degradation."
        );
      }

      const router = memoryJudge.mode !== "off"
        ? routerFactory(memoryJudge, { logger: api.logger, useCache: false })
        : null;

      const guidanceByAgent = new Map([...configs].map(([agentId, config]) => [agentId, buildGuidance(config)]));
      const turnDecisionCache = new Map();

      if (typeof cacheObserver === "function") {
        cacheObserver(turnDecisionCache);
      } else if (cacheObserver && typeof cacheObserver === "object") {
        cacheObserver.turnDecisionCache = turnDecisionCache;
      }

      function setTurnDecision(turnKey, decision) {
        const now = Date.now();
        for (const [k, v] of turnDecisionCache.entries()) {
          if (now - v.timestamp > CACHE_TTL_MS) {
            turnDecisionCache.delete(k);
          }
        }
        turnDecisionCache.set(turnKey, { decision, timestamp: now });
      }

      function getAndConsumeDecision(turnKey) {
        const entry = turnDecisionCache.get(turnKey);
        if (!entry) return null;
        turnDecisionCache.delete(turnKey);
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
          return null;
        }
        return entry.decision;
      }

      if (typeof api.on === "function") {
        // 1. Primary prompt build hook: before_prompt_build runs FIRST in OpenClaw lifecycle.
        // Evaluates routing, injects prependContext, and caches the single-use decision for before_agent_run.
        api.on("before_prompt_build", (event, context) => {
          const agentConfig = configs.get(context?.agentId);
          if (!agentConfig) return;
          const baseGuidance = guidanceByAgent.get(context?.agentId);
          if (!baseGuidance) return;

          // When router is off, or explicitly non-user trigger (e.g. heartbeat, cron, system), strictly preserve base guidance
          if (!router || memoryJudge.mode === "off" || isExplicitNonUserInput(context)) {
            return { prependContext: baseGuidance };
          }

          const text = extractUserPrompt(event);

          if (!text || text.trim().length === 0) {
            return { prependContext: baseGuidance };
          }

          const turnKey = getTurnKey(event, context, text);
          const turn = {
            host: "openclaw",
            sessionKey: context?.sessionKey ?? context?.sessionId ?? null,
            vaultPath: agentConfig.vaultPath,
            cwd: agentConfig.projectRoot ?? context?.workspaceDir ?? null,
            projectId: agentConfig.projectId ?? null
          };

          const fast = evaluateFastPath(text);
          if (fast.action !== "consult_laya") {
            const decision = {
              recallRecommended: fast.recallRecommended ?? false,
              captureRecommended: (fast.captureRecommended && memoryJudge.proactiveCapture !== false) ? true : false,
              captureCategory: fast.captureCategory ?? null,
              captureKind: (fast.captureRecommended && memoryJudge.proactiveCapture !== false) ? "explicit" : null,
              scope: fast.scope ?? "project",
              blocked: false,
              reason: fast.reason,
              trace: {
                route: "fast_path",
                decision: fast.recallRecommended ? "recall" : (fast.captureRecommended ? "capture" : "none"),
                reason: fast.reason,
                hookExecuted: true,
                layaAttempted: false
              }
            };
            decision.memoryAction = memoryActionFor(decision, memoryJudge.skipThreshold);
            if (router) {
              try { enrichDecision(decision, text, turn, memoryJudge); } catch {}
            }
            setTurnDecision(turnKey, decision);
            api.logger?.debug?.(`[Laya Memory Router] before_prompt_build Fast-Path Trace: ${JSON.stringify(decision.trace)}`);
            if (decision.memoryAction === "skip" || decision.recallRecommended ||
                (decision.captureRecommended && memoryJudge.proactiveCapture !== false) || buildLayaNotice(decision)) {
              return { prependContext: buildGuidance(agentConfig, decision) };
            }
            return { prependContext: baseGuidance };
          }

          return (async () => {
            try {
              const decision = await router.evaluateRecall(text, agentConfig.projectId ? { project_id: agentConfig.projectId } : null, turn);
              if (decision.trace) {
                decision.trace.hookExecuted = true;
                api.logger?.debug?.(`[Laya Memory Router] before_prompt_build Trace: ${JSON.stringify(decision.trace)}`);
              }
              setTurnDecision(turnKey, decision);
              // recall/capture add a hint; a confident "skip" replaces the workflow with a short notice;
              // a reminder from the previous turn (unsaved request, solved problem) also needs the hint.
              if (decision.memoryAction === "skip" || decision.recallRecommended || decision.captureRecommended || buildLayaNotice(decision)) {
                return { prependContext: buildGuidance(agentConfig, decision) };
              }
            } catch (err) {
              api.logger?.debug?.(`[Laya Memory Router] Evaluation failed: ${err.message}`);
              if (memoryJudge.mode === "strict") {
                setTurnDecision(turnKey, {
                  blocked: true,
                  reason: "strict_mode_evaluation_error",
                  trace: {
                    route: "fallback",
                    decision: "none",
                    reason: "strict_mode_evaluation_error",
                    hookExecuted: true,
                    layaAttempted: true
                  }
                });
              }
            }
            return { prependContext: baseGuidance };
          })();
        });

        // End of turn: an explicit "remember this" that produced no inbox candidate gets one more model
        // pass (at most once per request; the harness guards loops with stopHookActive).
        if (router && memoryJudge.proactiveCapture !== false) {
          api.on("before_agent_finalize", async (event, context) => {
            try {
              if (!event || event.stopHookActive) return;
              const agentConfig = configs.get(context?.agentId);
              if (!agentConfig) return;
              const sessionKey = context?.sessionKey ?? context?.sessionId ?? event.sessionKey ?? event.sessionId ?? null;
              const pending = pendingCaptureEnforcement({ host: "openclaw", sessionKey });
              if (pending) {
                api.logger?.debug?.("[Laya Memory Router] before_agent_finalize: explicit save request not staged, asking for a revision");
                return { action: "revise", reason: "obsidian_memory_capture_pending", retry: { instruction: pending.instruction, maxAttempts: 1 } };
              }
              // End-of-turn check on the final reply, only in "revise" / "remind" (autoCapture). The default
              // "digest" queues the turn in agent_end below and never asks for another pass.
              const reply = typeof event.lastAssistantMessage === "string" ? event.lastAssistantMessage : null;
              if (!reply || memoryJudge.autoCapture === "off" || memoryJudge.autoCapture === "digest") return;
              // Ask the local model only when the cheap features cannot decide (most turns never call it).
              const check = { host: "openclaw", sessionKey, assistantText: reply, mode: memoryJudge.autoCapture };
              const layaScore = turnEndNeedsScore(check) ? await router.captureScoreFor(reply) : null;
              const verdict = judgeTurnEndCapture({ ...check, layaScore });
              if (!verdict || memoryJudge.autoCapture !== "revise") return;
              api.logger?.debug?.(`[Laya Memory Router] before_agent_finalize: ${verdict.reason}, asking for a capture pass`);
              return { action: "revise", reason: "obsidian_memory_turn_end_capture", retry: { instruction: verdict.instruction, maxAttempts: 1 } };
            } catch (err) {
              api.logger?.debug?.(`[Laya Memory Router] before_agent_finalize error: ${err.message}`);
            }
          });

          // "digest": after a successful run, queue its request and final reply for the background
          // session digest (no model call, nothing for the agent to do).
          if (memoryJudge.autoCapture === "digest") {
            api.on("agent_end", (event, context) => {
              try {
                // Only real user turns: cron / heartbeat / system runs and failed model calls are not conversation.
                if (!event || event.success === false || event.error || isExplicitNonUserInput(context)) return;
                const agentConfig = configs.get(context?.agentId);
                if (!agentConfig) return;
                const { prompt, reply } = lastExchange(event.messages);
                if (!reply) return;
                enqueueTurnEnd({
                  host: "openclaw",
                  sessionKey: context?.sessionKey ?? context?.sessionId ?? null,
                  assistantText: reply,
                  prompt: prompt || null,
                  turn: { vaultPath: agentConfig.vaultPath, projectId: agentConfig.projectId ?? null, cwd: agentConfig.projectRoot ?? context?.workspaceDir ?? null }
                });
              } catch (err) {
                api.logger?.debug?.(`[Laya Memory Router] agent_end capture queue error: ${err.message}`);
              }
            });
          }
        }

        // 2. Strict mode official gatekeeper: before_agent_run runs SECOND in OpenClaw lifecycle.
        // Consumes and deletes the cached turn decision, or re-evaluates independently on cache miss (fail-closed).
        if (router && memoryJudge.mode === "strict") {
          api.on("before_agent_run", async (event, context) => {
            const agentConfig = configs.get(context?.agentId);
            if (!agentConfig) return;
            if (isExplicitNonUserInput(context)) return;

            const text = extractUserPrompt(event);

            if (!text || text.trim().length === 0) return;

            const turnKey = getTurnKey(event, context, text);
            const cachedDecision = getAndConsumeDecision(turnKey);

            if (cachedDecision) {
              if (cachedDecision.blocked) {
                return {
                  outcome: "block",
                  reason: cachedDecision.reason || "strict_mode_blocked",
                  message: "Laya Memory Router strict mode: request blocked by memory policy."
                };
              }
              return;
            }

            // Cache miss: Gatekeeper independently re-evaluates to guarantee fail-closed
            const fast = evaluateFastPath(text);
            if (fast.action !== "consult_laya") {
              return;
            }

            try {
              const decision = await router.evaluateRecall(text, agentConfig.projectId ? { project_id: agentConfig.projectId } : null);
              if (decision.trace) {
                decision.trace.hookExecuted = true;
                api.logger?.debug?.(`[Laya Memory Router] before_agent_run Trace: ${JSON.stringify(decision.trace)}`);
              }

              if (decision.blocked) {
                return {
                  outcome: "block",
                  reason: decision.reason || "strict_mode_service_unavailable",
                  message: "Laya Memory Router strict mode: memory service unavailable or blocked."
                };
              }
            } catch (err) {
              api.logger?.debug?.(`[Laya Memory Router] before_agent_run evaluation error: ${err.message}`);
              return {
                outcome: "block",
                reason: "strict_mode_evaluation_error",
                message: "Laya Memory Router strict mode: memory evaluation failed."
              };
            }
          });
        }
      }

      if (router && typeof api.onDispose === "function") {
        api.onDispose(() => {
          turnDecisionCache.clear();
          router.dispose();
        });
      }
    }
  };
}

const defaultPlugin = createOpenClawPlugin();
export default defaultPlugin;
