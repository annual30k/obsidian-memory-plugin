import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const connectionKeys = new Set(["agentId", "vault", "vaultPath", "cliPath", "projectId", "projectRoot"]);
const judgeKeys = new Set([
  "mode",
  "endpoint",
  "serviceFile",
  "timeout",
  "coldStartTimeout",
  "coldStart",
  "healthTimeout",
  "recallThreshold",
  "skipThreshold",
  "captureThreshold",
  "proactiveCapture",
  "layaCapture",
  "consecutiveFailures",
  "resetTimeout",
  "discoveryInterval",
  "decisionLog",
  "vaultHints",
  "vaultSemantic",
  "autoCapture"
]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function text(value, field, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > maxLength || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Obsidian Memory: invalid " + field);
  }
  return value;
}

function absolute(value, field) {
  const result = text(value, field);
  if (!isAbsolute(result)) throw new TypeError("Obsidian Memory: " + field + " must be an absolute path");
  return result;
}

function integer(value, field, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`Obsidian Memory: ${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function number(value, field, min, max) {
  if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
    throw new TypeError(`Obsidian Memory: ${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

export function validateLoopbackEndpoint(urlString) {
  if (typeof urlString !== "string" || !urlString) {
    throw new TypeError("Obsidian Memory: endpoint must be a non-empty string");
  }
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new TypeError("Obsidian Memory: endpoint must be a valid HTTP URL");
  }
  if (url.protocol !== "http:") {
    throw new TypeError("Obsidian Memory: endpoint protocol must be http:");
  }
  if (url.username || url.password) {
    throw new TypeError("Obsidian Memory: endpoint must not include userinfo");
  }
  if (url.search || url.hash) {
    throw new TypeError("Obsidian Memory: endpoint must not include query or hash");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new TypeError("Obsidian Memory: endpoint must not include a subpath");
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
    throw new TypeError("Obsidian Memory: endpoint must use loopback IP 127.0.0.1 or [::1]");
  }
  if (!url.port || Number(url.port) < 1 || Number(url.port) > 65535) {
    throw new TypeError("Obsidian Memory: endpoint must specify a valid port");
  }
  const cleanHost = (host === "[::1]" || host === "::1") ? "[::1]" : "127.0.0.1";
  return `http://${cleanHost}:${url.port}`;
}

// Where `laya start` writes service.json: $LAYA_HOME/.laya (default ~/.laya), the same rule as
// scripts/laya-service.mjs, so a relocated LAYA_HOME is found without extra configuration.
export function defaultServiceFilePath(env = process.env) {
  const base = typeof env.LAYA_HOME === "string" && env.LAYA_HOME.trim() ? env.LAYA_HOME.trim() : homedir();
  return join(base, ".laya", "service.json");
}

export function expandHomePath(filePath, options = {}) {
  if (typeof filePath !== "string" || !filePath) return filePath;
  const home = options.homedir ? options.homedir() : homedir();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(home, filePath.slice(2));
  }
  return filePath;
}

// Host hook timeout (seconds) for Codex/Antigravity/Hermes. It must exceed
// Node startup + healthTimeout + coldStartTimeout, otherwise the host kills the
// hook while a lazily unloaded Laya model is still loading (see tests).
export const HOST_HOOK_TIMEOUT_SECONDS = 10;

export const DEFAULT_MEMORY_JUDGE = Object.freeze({
  mode: "auto",
  endpoint: null,
  serviceFile: defaultServiceFilePath(),
  timeout: 1000,
  // MLX model load measured ~5.6 s on Apple Silicon; must stay below HOST_HOOK_TIMEOUT_SECONDS budget.
  coldStartTimeout: 7500,
  // "background": when the model is unloaded, start loading it and let this one turn use the
  // normal workflow instead of waiting seconds. "wait": block the turn up to coldStartTimeout.
  coldStart: "background",
  healthTimeout: 200,
  // Tuned with scripts/tune-laya-questions.py for the three-way memory-need question (see service.py).
  recallThreshold: 0.50,
  // Below this Laya score the turn is treated as self-contained and the agent is told NOT to load
  // the memory skill (saves the skill read and Vault search). Between skip and recall: normal workflow.
  skipThreshold: 0.35,
  captureThreshold: 0.75,
  proactiveCapture: true,
  // Deprecated no-op (0.7.0 only): model-suggested capture was removed. Still accepted so old configs load.
  layaCapture: false,
  consecutiveFailures: 2,
  resetTimeout: 300000,
  discoveryInterval: 300000,
  // Local, private log of routing decisions (~/.laya/decisions.jsonl) for `npm run laya:label`.
  decisionLog: true,
  // Match prompts against the Vault's notes to catch recalls Laya misses and to name the notes.
  vaultHints: true,
  // Semantic matching: embed the Vault's notes through the Laya service's retriever model and compare
  // the prompt's vector against them (falls back to word overlap when the service has no retriever).
  vaultSemantic: true,
  // Automatic capture of what a session concluded (explicit "remember" requests are separate and always on):
  // "digest"  hooks queue each turn's final reply locally and a background digest writes a few Inbox
  //           candidates per idle session (no extra model pass, no wait inside a turn);
  // "revise"  an end-of-turn check asks the agent for one more pass to stage a candidate (slower);
  // "remind"  the same check only reminds the agent at the start of the next turn;
  // "off"     no automatic capture.
  autoCapture: "digest"
});

const ENV_OFF = new Set(["0", "off", "false", "no"]);
const ENV_ON = new Set(["1", "on", "true", "yes"]);

function envBool(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (ENV_ON.has(v)) return true;
  if (ENV_OFF.has(v)) return false;
  return undefined;
}

/** The mode from the environment alone (for error paths, where the rest of the settings may be invalid). */
export function memoryJudgeModeFromEnv(env = process.env) {
  const mode = (env.OBSIDIAN_MEMORY_JUDGE_MODE ?? env.OBSIDIAN_MEMORY_ROUTER_MODE)?.trim();
  return ["off", "auto", "strict", "manual"].includes(mode) ? mode : DEFAULT_MEMORY_JUDGE.mode;
}

/**
 * memoryJudge settings for hosts configured through the environment (Codex, Antigravity, the background
 * digest, Hermes' Node side). One set of variables for all of them:
 *   OBSIDIAN_MEMORY_JUDGE_MODE (alias OBSIDIAN_MEMORY_ROUTER_MODE)  off | auto | strict | manual
 *   OBSIDIAN_MEMORY_ENDPOINT, OBSIDIAN_MEMORY_SERVICE_FILE
 *   OBSIDIAN_MEMORY_AUTO_CAPTURE      digest | revise | remind | off
 *   OBSIDIAN_MEMORY_PROACTIVE_CAPTURE, OBSIDIAN_MEMORY_VAULT_HINTS, OBSIDIAN_MEMORY_VAULT_SEMANTIC,
 *   OBSIDIAN_MEMORY_DECISION_LOG      1/0, on/off, true/false
 * `overrides` (already-validated values from the host) win over the environment. Invalid values are ignored.
 */
export function memoryJudgeFromEnv(env = process.env, overrides = {}) {
  const input = {};
  const mode = (env.OBSIDIAN_MEMORY_JUDGE_MODE ?? env.OBSIDIAN_MEMORY_ROUTER_MODE)?.trim();
  if (["off", "auto", "strict", "manual"].includes(mode)) input.mode = mode;
  if (env.OBSIDIAN_MEMORY_ENDPOINT?.trim()) input.endpoint = env.OBSIDIAN_MEMORY_ENDPOINT.trim();
  if (env.OBSIDIAN_MEMORY_SERVICE_FILE?.trim()) input.serviceFile = env.OBSIDIAN_MEMORY_SERVICE_FILE.trim();
  const auto = env.OBSIDIAN_MEMORY_AUTO_CAPTURE?.trim();
  if (["digest", "revise", "remind", "off"].includes(auto)) input.autoCapture = auto;
  for (const [key, name] of [["proactiveCapture", "OBSIDIAN_MEMORY_PROACTIVE_CAPTURE"], ["vaultHints", "OBSIDIAN_MEMORY_VAULT_HINTS"],
    ["vaultSemantic", "OBSIDIAN_MEMORY_VAULT_SEMANTIC"], ["decisionLog", "OBSIDIAN_MEMORY_DECISION_LOG"]]) {
    const value = envBool(env[name]);
    if (value !== undefined) input[key] = value;
  }
  // Invalid values throw, as before: a strict host must fail closed rather than run with other settings.
  return parseMemoryJudgeConfig({ ...input, ...overrides });
}

export function parseMemoryJudgeConfig(input) {
  if (input === undefined || input === null) {
    return DEFAULT_MEMORY_JUDGE;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Obsidian Memory: memoryJudge must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!judgeKeys.has(field)) {
      throw new TypeError("Obsidian Memory: unknown memoryJudge field");
    }
  }

  let mode = DEFAULT_MEMORY_JUDGE.mode;
  if (hasOwn(input, "mode")) {
    const rawMode = text(input.mode, "mode", 32);
    if (rawMode !== "off" && rawMode !== "auto" && rawMode !== "manual" && rawMode !== "strict") {
      throw new TypeError("Obsidian Memory: memoryJudge.mode must be off, auto, strict, or manual");
    }
    mode = rawMode;
  }

  let endpoint = DEFAULT_MEMORY_JUDGE.endpoint;
  if (hasOwn(input, "endpoint") && input.endpoint !== null && input.endpoint !== undefined) {
    endpoint = validateLoopbackEndpoint(input.endpoint);
  }

  if (mode === "manual" && !endpoint) {
    throw new TypeError("Obsidian Memory: memoryJudge.endpoint is required when mode is manual");
  }

  let serviceFile = DEFAULT_MEMORY_JUDGE.serviceFile;
  if (hasOwn(input, "serviceFile") && input.serviceFile !== null && input.serviceFile !== undefined) {
    serviceFile = absolute(expandHomePath(input.serviceFile), "serviceFile");
  }

  const timeout = hasOwn(input, "timeout")
    ? integer(input.timeout, "timeout", 50, 60000)
    : DEFAULT_MEMORY_JUDGE.timeout;

  const coldStartTimeout = hasOwn(input, "coldStartTimeout")
    ? integer(input.coldStartTimeout, "coldStartTimeout", 100, 120000)
    : DEFAULT_MEMORY_JUDGE.coldStartTimeout;

  let coldStart = DEFAULT_MEMORY_JUDGE.coldStart;
  if (hasOwn(input, "coldStart")) {
    if (input.coldStart !== "background" && input.coldStart !== "wait") {
      throw new TypeError("Obsidian Memory: memoryJudge.coldStart must be background or wait");
    }
    coldStart = input.coldStart;
  }

  const booleanField = (field) => {
    if (!hasOwn(input, field)) return DEFAULT_MEMORY_JUDGE[field];
    if (typeof input[field] !== "boolean") throw new TypeError(`Obsidian Memory: memoryJudge.${field} must be a boolean`);
    return input[field];
  };
  const decisionLog = booleanField("decisionLog");
  const vaultHints = booleanField("vaultHints");
  const vaultSemantic = booleanField("vaultSemantic");
  let autoCapture = DEFAULT_MEMORY_JUDGE.autoCapture;
  if (hasOwn(input, "autoCapture")) {
    if (!["digest", "revise", "remind", "off"].includes(input.autoCapture)) {
      throw new TypeError("Obsidian Memory: memoryJudge.autoCapture must be 'digest', 'revise', 'remind' or 'off'");
    }
    autoCapture = input.autoCapture;
  }

  const healthTimeout = hasOwn(input, "healthTimeout")
    ? integer(input.healthTimeout, "healthTimeout", 20, 10000)
    : DEFAULT_MEMORY_JUDGE.healthTimeout;

  const recallThreshold = hasOwn(input, "recallThreshold")
    ? number(input.recallThreshold, "recallThreshold", 0.0, 1.0)
    : DEFAULT_MEMORY_JUDGE.recallThreshold;

  // Never let "skip" overlap "recall".
  const skipThreshold = Math.min(recallThreshold, hasOwn(input, "skipThreshold")
    ? number(input.skipThreshold, "skipThreshold", 0.0, 1.0)
    : DEFAULT_MEMORY_JUDGE.skipThreshold);

  const captureThreshold = hasOwn(input, "captureThreshold")
    ? number(input.captureThreshold, "captureThreshold", 0.0, 1.0)
    : DEFAULT_MEMORY_JUDGE.captureThreshold;

  let proactiveCapture = DEFAULT_MEMORY_JUDGE.proactiveCapture;
  if (hasOwn(input, "proactiveCapture")) {
    if (typeof input.proactiveCapture !== "boolean") {
      throw new TypeError("Obsidian Memory: memoryJudge.proactiveCapture must be a boolean");
    }
    proactiveCapture = input.proactiveCapture;
  }

  let layaCapture = DEFAULT_MEMORY_JUDGE.layaCapture;
  if (hasOwn(input, "layaCapture")) {
    if (typeof input.layaCapture !== "boolean") {
      throw new TypeError("Obsidian Memory: memoryJudge.layaCapture must be a boolean");
    }
    layaCapture = input.layaCapture;
  }

  const consecutiveFailures = hasOwn(input, "consecutiveFailures")
    ? integer(input.consecutiveFailures, "consecutiveFailures", 1, 10)
    : DEFAULT_MEMORY_JUDGE.consecutiveFailures;

  const resetTimeout = hasOwn(input, "resetTimeout")
    ? integer(input.resetTimeout, "resetTimeout", 1000, 3600000)
    : DEFAULT_MEMORY_JUDGE.resetTimeout;

  const discoveryInterval = hasOwn(input, "discoveryInterval")
    ? integer(input.discoveryInterval, "discoveryInterval", 1000, 3600000)
    : DEFAULT_MEMORY_JUDGE.discoveryInterval;

  return Object.freeze({
    mode,
    endpoint,
    serviceFile,
    timeout,
    coldStartTimeout,
    coldStart,
    healthTimeout,
    recallThreshold,
    skipThreshold,
    captureThreshold,
    proactiveCapture,
    layaCapture,
    consecutiveFailures,
    resetTimeout,
    discoveryInterval,
    decisionLog,
    vaultHints,
    vaultSemantic,
    autoCapture
  });
}

export function parseConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Obsidian Memory: config must be an object");
  }
  const fields = Object.keys(input);
  if (fields.length === 0) return null;
  for (const field of fields) {
    if (!connectionKeys.has(field)) throw new TypeError("Obsidian Memory: unknown config field");
  }
  const config = {
    agentId: text(input.agentId, "agentId", 128),
    vaultPath: absolute(input.vaultPath, "vaultPath"),
    cliPath: hasOwn(input, "cliPath") ? text(input.cliPath, "cliPath") : "obsidian"
  };
  if (hasOwn(input, "vault")) config.vault = text(input.vault, "vault", 256);
  if (config.cliPath !== "obsidian" && !isAbsolute(config.cliPath)) {
    throw new TypeError("Obsidian Memory: cliPath must be obsidian or an absolute executable path");
  }
  if (hasOwn(input, "projectId")) {
    config.projectId = text(input.projectId, "projectId", 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(config.projectId)) {
      throw new TypeError("Obsidian Memory: invalid projectId");
    }
  }
  if (hasOwn(input, "projectRoot")) {
    config.projectRoot = absolute(input.projectRoot, "projectRoot");
  }
  return Object.freeze(config);
}

export function parseConfigs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Obsidian Memory: config must be an object");
  }

  const memoryJudge = parseMemoryJudgeConfig(input.memoryJudge);
  const remaining = { ...input };
  delete remaining.memoryJudge;

  if (hasOwn(remaining, "agentConfigs")) {
    if (Object.keys(remaining).length !== 1 || !remaining.agentConfigs || typeof remaining.agentConfigs !== "object" || Array.isArray(remaining.agentConfigs)) {
      throw new TypeError("Obsidian Memory: agentConfigs must be the only connection config field");
    }
    const entries = Object.entries(remaining.agentConfigs);
    if (entries.length === 0) throw new TypeError("Obsidian Memory: agentConfigs must not be empty");
    const map = new Map(entries.map(([agentId, connection]) => [agentId, parseConfig({ ...connection, agentId })]));
    map.memoryJudge = memoryJudge;
    return map;
  }

  if (Object.keys(remaining).length === 0) {
    const map = new Map();
    map.memoryJudge = memoryJudge;
    return map;
  }

  const config = parseConfig(remaining);
  const map = config ? new Map([[config.agentId, config]]) : new Map();
  map.memoryJudge = memoryJudge;
  return map;
}
