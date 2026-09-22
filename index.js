import { DEFAULT_MEMORY_JUDGE, parseConfigs } from "./lib/config.js";
import { buildGuidance } from "./lib/prompt.js";
import { createMemoryRouter } from "./lib/memory-router/router.js";
import { evaluateFastPath } from "./lib/memory-router/fast-path.js";

// A native OpenClaw entry object. No SDK/runtime dependency or build step.
export default {
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
    const router = memoryJudge.mode !== "off"
      ? createMemoryRouter(memoryJudge, { logger: api.logger, useCache: false })
      : null;

    const guidanceByAgent = new Map([...configs].map(([agentId, config]) => [agentId, buildGuidance(config)]));

    api.on("before_prompt_build", (event, context) => {
      const agentConfig = configs.get(context?.agentId);
      if (!agentConfig) return;
      const baseGuidance = guidanceByAgent.get(context?.agentId);
      if (!baseGuidance) return;

      // When router is off, or non-user trigger (e.g. heartbeat, cron, system), strictly preserve base guidance
      if (!router || memoryJudge.mode === "off" || context?.trigger !== "user") {
        return { prependContext: baseGuidance };
      }

      // Read only event.prompt for user turns per OpenClaw typings
      let text = "";
      try {
        if (typeof event?.prompt === "string") {
          text = event.prompt;
        }
      } catch {
        text = "";
      }

      if (!text || text.trim().length === 0) {
        return { prependContext: baseGuidance };
      }

      const fast = evaluateFastPath(text);
      if (fast.action !== "consult_laya") {
        if (fast.recallRecommended) {
          return { prependContext: buildGuidance(agentConfig, { recallRecommended: true, scope: "project" }) };
        }
        return { prependContext: baseGuidance };
      }

      return (async () => {
        try {
          const decision = await router.evaluateRecall(text, {
            project_id: agentConfig.projectId ?? null
          });
          if (decision.recallRecommended) {
            return { prependContext: buildGuidance(agentConfig, decision) };
          }
        } catch (err) {
          api.logger?.debug?.(`[Laya Memory Router] Evaluation failed: ${err.message}`);
        }
        return { prependContext: baseGuidance };
      })();
    });

    if (router && typeof api.onDispose === "function") {
      api.onDispose(() => router.dispose());
    }
  }
};
