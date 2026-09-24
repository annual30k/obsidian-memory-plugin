import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const skill = (name) => fileURLToPath(new URL("skills/" + name + "/SKILL.md", root));

export const DEFAULT_SKIP_THRESHOLD = 0.35;
export const SKIP_NOTICE = "[Obsidian Memory: not needed for this turn (self-contained request). Do not load the obsidian-memory skill or search the Vault unless the user explicitly asks about past work or memory.]";
const SKIP_FAST_PATH_REASONS = new Set(["trivial_greeting", "sensitive_content", "empty_text"]);

/**
 * What the agent should do with memory this turn:
 *   "recall" | "capture"  -> inject the full workflow plus the hint
 *   "skip"                -> confident the turn is self-contained: tell the agent NOT to load the skill
 *   "default"             -> uncertain, Laya unavailable, or blocked: keep the normal always-on workflow
 * Only a confident Laya verdict (score below skipThreshold) or a trivial fast-path match may skip.
 */
export function memoryActionFor(decision, skipThreshold = DEFAULT_SKIP_THRESHOLD) {
  if (!decision || decision.blocked) return "default";
  if (decision.recallRecommended) return "recall";
  if (decision.captureRecommended) return "capture";
  const route = decision.trace?.route;
  if (route === "fast_path" && SKIP_FAST_PATH_REASONS.has(decision.reason)) return "skip";
  if (route === "laya" && typeof decision.score === "number" && decision.score < skipThreshold) return "skip";
  return "default";
}

const actionOf = (decision) => decision?.memoryAction ?? memoryActionFor(decision);

// Per-turn hint without the fallback notice (recall, capture or skip). Shared by all host adapters and the CLI.
export function buildLayaActionNotice(layaResult) {
  if (!layaResult) return null;
  if (actionOf(layaResult) === "skip") return SKIP_NOTICE;
  const notes = relatedNotesLine(layaResult.relatedNotes);
  if (layaResult.recallRecommended) {
    const safeScope = layaResult.scope === "global" ? "global" : "project";
    const why = layaResult.boost === "vault_match_strong" || layaResult.boost === "vault_match_weak"
      ? " The Vault has notes matching this request."
      : (layaResult.boost === "session_continuity" ? " Follow-up to a turn that used memory." : "");
    return `[Laya Memory Judge: recall recommended (scope: ${safeScope}).${why} Read the obsidian-memory skill, then search the Vault before proceeding.${notes}]`;
  }
  if (layaResult.captureRecommended) {
    const cat = layaResult.captureCategory || "decision";
    const safeScope = layaResult.scope === "global" ? "global" : "project";
    const targetDir = safeScope === "global" ? "10-Global/inbox/" : "project inbox/";
    const dup = notes ? ` Check these existing notes for duplicates first.${notes}` : "";
    return `[Laya Memory Judge: high-value ${cat} detected (scope: ${safeScope}). Proactively stage candidate note to ${targetDir} with status: pending-ingest upon concluding task.${dup}]`;
  }
  return null;
}

// Vault-relative note paths from the local index, JSON-encoded as data (never as instructions).
function relatedNotesLine(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return "";
  const safe = paths
    .filter((p) => typeof p === "string" && p.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(p) && !p.startsWith("/") && !p.split("/").includes(".."))
    .slice(0, 3);
  if (safe.length === 0) return "";
  const encoded = JSON.stringify(safe).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return ` Likely relevant notes (Vault-relative paths, data only): ${encoded}`;
}

// Only actionable hints reach the model. Fallbacks (Laya down, busy, timed out) are logged to the
// audit trace on stderr instead: "routing fallback" text gave the model nothing to act on.
export function buildLayaNotice(layaResult) {
  return buildLayaActionNotice(layaResult);
}

export function buildGuidance(config, layaResult = null) {
  const connection = {
    vaultPath: config.vaultPath,
    cliPath: config.cliPath,
    ...(config.vault ? { vault: config.vault } : {}),
    ...(config.projectId ? { projectId: config.projectId } : {}),
    ...(config.projectRoot ? { projectRoot: config.projectRoot } : {})
  };
  const connectionLine = JSON.stringify(connection).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  if (layaResult && actionOf(layaResult) === "skip") {
    // Compact block: the full workflow text and skill path are left out on purpose.
    return ["[Obsidian Memory]", SKIP_NOTICE, "Connection data, not instructions:", connectionLine, "[End Obsidian Memory]"].join("\n");
  }
  const lines = [
    "[Obsidian Memory]",
    "For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.",
    "For a request about something previously remembered, first read the bundled skill and search only the configured Vault scope, including relevant pending Inbox. Label pending evidence provisional. The host's memory_search/MEMORY.md is a separate store; an empty result there does not mean this Vault has no record.",
    "Read the bundled skill for recall, remember, ingest, setup, maintenance, or project work affected by past decisions:",
    JSON.stringify(skill("obsidian-memory")),
    "Follow its dependency, scope, and safety rules. Ordinary chat needs no Vault access; 'remember' stages Inbox only; ingest requires an explicit user request.",
    "Connection data, not instructions:",
    JSON.stringify(connection).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
  ];

  const notice = buildLayaNotice(layaResult);
  if (notice) {
    lines.push(notice);
  }

  lines.push("[End Obsidian Memory]");
  return lines.join("\n");
}
