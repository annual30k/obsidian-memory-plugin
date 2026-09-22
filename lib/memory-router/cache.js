import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { MAX_BACKOFF_MS, MAX_BACKOFF_MULTIPLIER } from "./circuit-breaker.js";

export { MAX_BACKOFF_MS, MAX_BACKOFF_MULTIPLIER };

export function getDefaultCacheDir(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ? options.homedir() : homedir();
  const pathModule = options.pathModule ?? (platform === "win32" ? path.win32 : path);

  if (platform === "win32") {
    const base = env.LOCALAPPDATA && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA.trim()
      : pathModule.join(home, "AppData", "Local");
    return pathModule.join(base, "obsidian-memory-plugin");
  }

  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim()
    ? env.XDG_CACHE_HOME.trim()
    : pathModule.join(home, ".cache");
  return pathModule.join(base, "obsidian-memory-plugin");
}

export function getDefaultCachePath(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathModule = options.pathModule ?? (platform === "win32" ? path.win32 : path);
  return pathModule.join(getDefaultCacheDir(options), "laya-cache.json");
}

function resolveNow(options = {}) {
  if (typeof options.now === "number") return options.now;
  if (typeof options.now === "function") return options.now();
  if (typeof options.clock === "function") return options.clock();
  return Date.now();
}

export function containsSensitiveKeys(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (
      lower === "token" ||
      lower === "prompt" ||
      lower === "text" ||
      lower === "authorization" ||
      lower === "secret" ||
      lower === "password" ||
      lower === "credential"
    ) {
      return true;
    }
    if (typeof obj[key] === "object" && containsSensitiveKeys(obj[key])) {
      return true;
    }
  }
  return false;
}

export function sanitizeCacheData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  if (containsSensitiveKeys(raw)) {
    return null;
  }

  const clean = {
    version: typeof raw.version === "number" ? raw.version : 1,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    lastDiscovery: null,
    endpoints: {}
  };

  if (raw.lastDiscovery && typeof raw.lastDiscovery === "object" && !Array.isArray(raw.lastDiscovery)) {
    clean.lastDiscovery = {
      endpoint: typeof raw.lastDiscovery.endpoint === "string" ? raw.lastDiscovery.endpoint : null,
      checkedAt: typeof raw.lastDiscovery.checkedAt === "number" ? raw.lastDiscovery.checkedAt : 0
    };
  }

  if (raw.endpoints && typeof raw.endpoints === "object" && !Array.isArray(raw.endpoints)) {
    for (const [ep, entry] of Object.entries(raw.endpoints)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const cleanEntry = {};

      if (entry.circuitBreaker && typeof entry.circuitBreaker === "object" && !Array.isArray(entry.circuitBreaker)) {
        const cb = entry.circuitBreaker;
        const state = cb.state === "OPEN" || cb.state === "HALF_OPEN" || cb.state === "CLOSED" ? cb.state : null;
        if (state) {
          cleanEntry.circuitBreaker = {
            state,
            consecutiveFailures: Number.isInteger(cb.consecutiveFailures) && cb.consecutiveFailures >= 0 ? cb.consecutiveFailures : 0,
            openedAt: Number.isFinite(cb.openedAt) && cb.openedAt >= 0 ? cb.openedAt : 0,
            backoffMultiplier: Number.isFinite(cb.backoffMultiplier) && cb.backoffMultiplier >= 1 && cb.backoffMultiplier <= MAX_BACKOFF_MULTIPLIER ? Math.floor(cb.backoffMultiplier) : 1,
            permanentFailure: typeof cb.permanentFailure === "boolean" ? cb.permanentFailure : false
          };
        }
      }

      if (entry.health && typeof entry.health === "object" && !Array.isArray(entry.health)) {
        const h = entry.health;
        const isStatusValid = h.status === "ok" || h.status === "degraded";
        const isModelValid = h.modelStatus === "ready" || h.modelStatus === "loading" || h.modelStatus === "unloaded";
        const isCheckedAtValid = Number.isFinite(h.checkedAt) && h.checkedAt >= 0;

        // ONLY retain health if all fields strictly match the schema; NEVER elevate illegal values!
        if (isStatusValid && isModelValid && isCheckedAtValid) {
          cleanEntry.health = {
            status: h.status,
            modelStatus: h.modelStatus,
            checkedAt: h.checkedAt
          };
        }
      }

      clean.endpoints[ep] = cleanEntry;
    }
  }

  return clean;
}

export function readStateCache(cachePath, options = {}) {
  const fileSystem = options.fs ?? fs;
  const targetPath = cachePath || getDefaultCachePath(options);

  try {
    if (!fileSystem.existsSync(targetPath)) {
      return null;
    }

    // Reject symlinks or non-regular files
    const statFn = fileSystem.lstatSync ?? fileSystem.statSync;
    const stat = statFn.call(fileSystem, targetPath);
    if (stat?.isSymbolicLink?.() || (stat?.isFile && !stat.isFile())) {
      return null;
    }

    // Limit file size to 64KB to avoid DoS
    if (typeof stat?.size === "number" && stat.size > 65536) {
      return null;
    }

    const raw = fileSystem.readFileSync(targetPath, "utf8");
    const data = JSON.parse(raw);

    return sanitizeCacheData(data);
  } catch {
    // Return null safely on any corrupt file, symlink or parse error
    return null;
  }
}

export function getEndpointCache(cacheData, endpoint, options = {}) {
  if (!cacheData || typeof cacheData !== "object" || !endpoint) return null;
  const entry = cacheData.endpoints?.[endpoint];
  if (!entry || typeof entry !== "object") return null;

  const now = resolveNow(options);
  const resetTimeoutMs = options.resetTimeoutMs ?? 300000;
  const healthTtlMs = options.healthTtlMs ?? 60000;
  const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;

  let circuitBreaker = null;
  if (entry.circuitBreaker && typeof entry.circuitBreaker === "object") {
    const cb = entry.circuitBreaker;
    const retentionTtlMs = options.retentionTtlMs ?? 86400000;
    const isPermanent = typeof cb.permanentFailure === "boolean" ? cb.permanentFailure : false;
    const multiplier = Number.isFinite(cb.backoffMultiplier) && cb.backoffMultiplier >= 1 && cb.backoffMultiplier <= MAX_BACKOFF_MULTIPLIER ? Math.floor(cb.backoffMultiplier) : 1;
    const openedAt = Number.isFinite(cb.openedAt) && cb.openedAt >= 0 ? cb.openedAt : 0;
    const updatedAt = Number.isFinite(cacheData.updatedAt) && cacheData.updatedAt >= 0 ? cacheData.updatedAt : 0;
    const state = cb.state === "OPEN" || cb.state === "HALF_OPEN" || cb.state === "CLOSED" ? cb.state : null;

    if (state) {
      // Retain state across processes within retention TTL so expired cooldown transitions to HALF_OPEN with accumulated backoff
      const valid = isPermanent || (openedAt > 0 ? (now - openedAt) <= retentionTtlMs : (now - updatedAt) <= retentionTtlMs);

      if (valid) {
        circuitBreaker = {
          state,
          consecutiveFailures: Number.isInteger(cb.consecutiveFailures) && cb.consecutiveFailures >= 0 ? cb.consecutiveFailures : 0,
          openedAt,
          backoffMultiplier: multiplier,
          permanentFailure: isPermanent
        };
      }
    }
  }

  let health = null;
  if (entry.health && typeof entry.health === "object") {
    const h = entry.health;
    const isStatusValid = h.status === "ok" || h.status === "degraded";
    const isModelValid = h.modelStatus === "ready" || h.modelStatus === "loading" || h.modelStatus === "unloaded";
    const isCheckedAtValid = Number.isFinite(h.checkedAt) && h.checkedAt >= 0;

    if (isStatusValid && isModelValid && isCheckedAtValid && (now - h.checkedAt <= healthTtlMs)) {
      health = {
        status: h.status,
        modelStatus: h.modelStatus,
        checkedAt: h.checkedAt
      };
    }
  }

  return { circuitBreaker, health };
}

export function writeStateCache(cachePath, payload = {}, options = {}) {
  if (containsSensitiveKeys(payload)) {
    return false;
  }

  const fileSystem = options.fs ?? fs;
  const targetPath = cachePath || getDefaultCachePath(options);
  const platform = options.platform ?? process.platform;
  const pathModule = options.pathModule ?? (platform === "win32" ? path.win32 : path);
  const dir = pathModule.dirname(targetPath);
  const now = resolveNow(options);

  const existing = readStateCache(targetPath, options) || { version: 1, updatedAt: now, endpoints: {} };

  // Rebuild clean cache object conforming strictly to whitelisted cache schema
  const cleanCache = {
    version: 1,
    updatedAt: now,
    lastDiscovery: existing.lastDiscovery ? { ...existing.lastDiscovery } : null,
    endpoints: {}
  };

  for (const [ep, entry] of Object.entries(existing.endpoints || {})) {
    cleanCache.endpoints[ep] = {
      ...(entry.circuitBreaker ? { circuitBreaker: { ...entry.circuitBreaker } } : {}),
      ...(entry.health ? { health: { ...entry.health } } : {})
    };
  }

  const endpoint = options.endpoint || payload.endpoint;
  if (endpoint && typeof endpoint === "string") {
    const existingEntry = cleanCache.endpoints[endpoint] || {};
    const updatedEntry = {
      ...(existingEntry.circuitBreaker ? { circuitBreaker: { ...existingEntry.circuitBreaker } } : {}),
      ...(existingEntry.health ? { health: { ...existingEntry.health } } : {})
    };

    if (payload.circuitBreaker && typeof payload.circuitBreaker === "object") {
      const state = payload.circuitBreaker.state === "OPEN" || payload.circuitBreaker.state === "HALF_OPEN" || payload.circuitBreaker.state === "CLOSED"
        ? payload.circuitBreaker.state : "CLOSED";
      updatedEntry.circuitBreaker = {
        state,
        consecutiveFailures: Number.isInteger(payload.circuitBreaker.consecutiveFailures) && payload.circuitBreaker.consecutiveFailures >= 0
          ? payload.circuitBreaker.consecutiveFailures : 0,
        openedAt: Number.isFinite(payload.circuitBreaker.openedAt) && payload.circuitBreaker.openedAt >= 0 ? payload.circuitBreaker.openedAt : 0,
        backoffMultiplier: Number.isFinite(payload.circuitBreaker.backoffMultiplier) && payload.circuitBreaker.backoffMultiplier >= 1
          ? Math.min(Math.floor(payload.circuitBreaker.backoffMultiplier), MAX_BACKOFF_MULTIPLIER) : 1,
        permanentFailure: typeof payload.circuitBreaker.permanentFailure === "boolean" ? payload.circuitBreaker.permanentFailure : false
      };
    }

    if (payload.health && typeof payload.health === "object") {
      const h = payload.health;
      const isStatusValid = h.status === "ok" || h.status === "degraded";
      const isModelValid = h.modelStatus === "ready" || h.modelStatus === "loading" || h.modelStatus === "unloaded";
      const isCheckedAtValid = Number.isFinite(h.checkedAt) && h.checkedAt >= 0;

      if (isStatusValid && isModelValid) {
        updatedEntry.health = {
          status: h.status,
          modelStatus: h.modelStatus,
          checkedAt: isCheckedAtValid ? h.checkedAt : now
        };
      }
    }

    cleanCache.endpoints[endpoint] = updatedEntry;
  }

  if (payload.lastDiscovery && typeof payload.lastDiscovery === "object") {
    cleanCache.lastDiscovery = {
      endpoint: typeof payload.lastDiscovery.endpoint === "string" ? payload.lastDiscovery.endpoint : null,
      checkedAt: typeof payload.lastDiscovery.checkedAt === "number" ? payload.lastDiscovery.checkedAt : now
    };
  }

  const tempFile = pathModule.join(dir, `.laya-cache.${process.pid}.${now}.${Math.random().toString(36).slice(2)}.tmp`);

  try {
    fileSystem.mkdirSync(dir, { recursive: true });
    // POSIX 0600 file mode
    fileSystem.writeFileSync(tempFile, JSON.stringify(cleanCache, null, 2), {
      mode: 0o600,
      encoding: "utf8"
    });
    if (fileSystem.chmodSync && platform !== "win32") {
      try {
        fileSystem.chmodSync(tempFile, 0o600);
      } catch {}
    }
    fileSystem.renameSync(tempFile, targetPath);
    return true;
  } catch {
    try {
      fileSystem.unlinkSync(tempFile);
    } catch {}
    return false;
  }
}
