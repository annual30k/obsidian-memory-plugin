import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const connectionKeys = new Set(["agentId", "vault", "vaultPath", "cliPath", "projectId", "projectRoot"]);
const judgeKeys = new Set([
  "mode",
  "endpoint",
  "serviceFile",
  "timeout",
  "coldStartTimeout",
  "healthTimeout",
  "recallThreshold",
  "captureThreshold",
  "proactiveCapture",
  "consecutiveFailures",
  "resetTimeout",
  "discoveryInterval"
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

export function defaultServiceFilePath() {
  return join(homedir(), ".laya", "service.json");
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

export const DEFAULT_MEMORY_JUDGE = Object.freeze({
  mode: "off",
  endpoint: null,
  serviceFile: defaultServiceFilePath(),
  timeout: 1000,
  coldStartTimeout: 5000,
  healthTimeout: 200,
  recallThreshold: 0.70,
  captureThreshold: 0.75,
  proactiveCapture: true,
  consecutiveFailures: 2,
  resetTimeout: 300000,
  discoveryInterval: 300000
});

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
    if (rawMode !== "off" && rawMode !== "auto" && rawMode !== "manual") {
      throw new TypeError("Obsidian Memory: memoryJudge.mode must be off, auto, or manual");
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

  const healthTimeout = hasOwn(input, "healthTimeout")
    ? integer(input.healthTimeout, "healthTimeout", 20, 10000)
    : DEFAULT_MEMORY_JUDGE.healthTimeout;

  const recallThreshold = hasOwn(input, "recallThreshold")
    ? number(input.recallThreshold, "recallThreshold", 0.0, 1.0)
    : DEFAULT_MEMORY_JUDGE.recallThreshold;

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
    healthTimeout,
    recallThreshold,
    captureThreshold,
    proactiveCapture,
    consecutiveFailures,
    resetTimeout,
    discoveryInterval
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
