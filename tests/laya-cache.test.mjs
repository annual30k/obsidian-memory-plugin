import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getDefaultCacheDir,
  getDefaultCachePath,
  readStateCache,
  writeStateCache,
  getEndpointCache
} from "../lib/memory-router/cache.js";

test("getDefaultCacheDir handles POSIX XDG_CACHE_HOME and fallback", () => {
  const custom = getDefaultCacheDir({
    platform: "linux",
    env: { XDG_CACHE_HOME: "/custom/cache" },
    homedir: () => "/home/test"
  });
  assert.equal(custom, "/custom/cache/obsidian-memory-plugin");

  const fallback = getDefaultCacheDir({
    platform: "linux",
    env: {},
    homedir: () => "/home/test"
  });
  assert.equal(fallback, "/home/test/.cache/obsidian-memory-plugin");
});

test("getDefaultCacheDir handles Windows LOCALAPPDATA with spaces, fallback, and win32 pathModule", () => {
  const withSpaces = getDefaultCacheDir({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\John Doe\\AppData\\Local" },
    homedir: () => "C:\\Users\\John Doe",
    pathModule: path.win32
  });
  assert.equal(withSpaces, "C:\\Users\\John Doe\\AppData\\Local\\obsidian-memory-plugin");

  const fallback = getDefaultCacheDir({
    platform: "win32",
    env: {},
    homedir: () => "C:\\Users\\John Doe",
    pathModule: path.win32
  });
  assert.equal(fallback, "C:\\Users\\John Doe\\AppData\\Local\\obsidian-memory-plugin");
});

test("getDefaultCachePath produces correct file path for platform", () => {
  const winPath = getDefaultCachePath({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Bob\\AppData\\Local" },
    pathModule: path.win32
  });
  assert.equal(winPath, "C:\\Users\\Bob\\AppData\\Local\\obsidian-memory-plugin\\laya-cache.json");

  const posixPath = getDefaultCachePath({
    platform: "linux",
    env: { XDG_CACHE_HOME: "/home/bob/.cache" },
    pathModule: path.posix
  });
  assert.equal(posixPath, "/home/bob/.cache/obsidian-memory-plugin/laya-cache.json");
});

test("writeStateCache writes atomically with POSIX 0600 permissions", () => {
  let writtenFiles = {};
  let chmodCalls = [];
  let renamedFiles = [];

  const mockFs = {
    existsSync: (p) => Boolean(writtenFiles[p]),
    readFileSync: (p) => writtenFiles[p],
    mkdirSync: () => {},
    writeFileSync: (p, content, opts) => {
      writtenFiles[p] = content;
      assert.equal(opts.mode, 0o600);
    },
    chmodSync: (p, mode) => {
      chmodCalls.push({ p, mode });
    },
    renameSync: (from, to) => {
      renamedFiles.push({ from, to });
      writtenFiles[to] = writtenFiles[from];
      delete writtenFiles[from];
    },
    unlinkSync: (p) => {
      delete writtenFiles[p];
    },
    statSync: (p) => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: writtenFiles[p]?.length ?? 0
    })
  };

  const success = writeStateCache("/cache/laya-cache.json", {
    circuitBreaker: { state: "CLOSED" }
  }, {
    endpoint: "http://127.0.0.1:18791",
    fs: mockFs,
    platform: "linux"
  });

  assert.equal(success, true);
  assert.equal(renamedFiles.length, 1);
  assert.equal(renamedFiles[0].to, "/cache/laya-cache.json");
  assert.ok(chmodCalls.some(c => c.mode === 0o600));
});

test("readStateCache safely handles corruption, symlinks, and oversized files", () => {
  // 1. Corrupt JSON
  const corruptFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 50 }),
    readFileSync: () => "{ corrupted json ... "
  };
  assert.equal(readStateCache("/cache.json", { fs: corruptFs }), null);

  // 2. Symlink
  const symlinkFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true, size: 50 }),
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => true, size: 50 }),
    readFileSync: () => "{}"
  };
  assert.equal(readStateCache("/cache.json", { fs: symlinkFs }), null);

  // 3. Oversized file (> 64KB)
  const oversizedFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 70000 }),
    readFileSync: () => "{}"
  };
  assert.equal(readStateCache("/cache.json", { fs: oversizedFs }), null);
});

test("readStateCache rejects files containing tokens or prompts", () => {
  const tokenFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
    readFileSync: () => JSON.stringify({ token: "secret_value_123" })
  };
  assert.equal(readStateCache("/cache.json", { fs: tokenFs }), null);

  const promptFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
    readFileSync: () => JSON.stringify({ prompt: "sensitive user query" })
  };
  assert.equal(readStateCache("/cache.json", { fs: promptFs }), null);
});

test("getEndpointCache isolates endpoint states and respects dynamic backoff TTL", () => {
  const now = 1000000;
  const cacheData = {
    version: 1,
    updatedAt: now,
    endpoints: {
      "http://127.0.0.1:18791": {
        circuitBreaker: {
          state: "OPEN",
          consecutiveFailures: 3,
          openedAt: now - 600000, // 10 minutes ago
          backoffMultiplier: 4,   // resetTimeout 300s * 4 = 1200s (20 minutes)
          permanentFailure: false
        },
        health: {
          status: "ok",
          modelStatus: "ready",
          checkedAt: now - 30000 // 30 seconds ago
        }
      },
      "http://127.0.0.1:19999": {
        circuitBreaker: {
          state: "CLOSED",
          consecutiveFailures: 0,
          openedAt: 0,
          backoffMultiplier: 1,
          permanentFailure: false
        },
        health: {
          status: "ok",
          modelStatus: "ready",
          checkedAt: now - 120000 // 2 minutes ago (expired for health)
        }
      }
    }
  };

  // Endpoint 1: OPEN state with 20min cooldown is STILL valid at 10min (would have been dropped by 5min TTL!)
  const ep1 = getEndpointCache(cacheData, "http://127.0.0.1:18791", {
    now,
    resetTimeoutMs: 300000,
    healthTtlMs: 60000
  });
  assert.ok(ep1.circuitBreaker);
  assert.equal(ep1.circuitBreaker.state, "OPEN");
  assert.equal(ep1.circuitBreaker.backoffMultiplier, 4);
  assert.ok(ep1.health);
  assert.equal(ep1.health.status, "ok");

  // Endpoint 2: CLOSED state, health is 2min old so health is expired, but breaker is valid
  const ep2 = getEndpointCache(cacheData, "http://127.0.0.1:19999", {
    now,
    resetTimeoutMs: 300000,
    healthTtlMs: 60000
  });
  assert.ok(ep2.circuitBreaker);
  assert.equal(ep2.circuitBreaker.state, "CLOSED");
  assert.equal(ep2.health, null, "Health checked 2 minutes ago should be expired under 60s TTL");

  // Endpoint 3: Non-existent endpoint returns null
  const ep3 = getEndpointCache(cacheData, "http://127.0.0.1:8888", { now });
  assert.equal(ep3, null);
});

test("Cross-process exponential backoff: new process after cooldown hydrates OPEN and increases multiplier from 4 to 6 on failed probe", async () => {
  let fileStore = {};
  const mockFs = {
    existsSync: (p) => Boolean(fileStore[p]),
    readFileSync: (p) => fileStore[p],
    writeFileSync: (p, data) => { fileStore[p] = data; },
    renameSync: (from, to) => { fileStore[to] = fileStore[from]; delete fileStore[from]; },
    unlinkSync: (p) => { delete fileStore[p]; },
    statSync: (p) => ({ isFile: () => true, isSymbolicLink: () => false, size: fileStore[p]?.length ?? 0 }),
    mkdirSync: () => {}
  };

  const cachePath = "/test/laya-cache.json";
  const initialOpenedAt = 1000000;
  const resetTimeoutMs = 300000;
  // Cooldown = 300000 * 4 = 1200000ms

  // Initial process 1 writes OPEN state with multiplier 4
  writeStateCache(cachePath, {
    circuitBreaker: {
      state: "OPEN",
      consecutiveFailures: 3,
      openedAt: initialOpenedAt,
      backoffMultiplier: 4,
      permanentFailure: false
    }
  }, {
    endpoint: "http://127.0.0.1:18791",
    fs: mockFs,
    now: initialOpenedAt
  });

  // Process 2 starts after cooldown has expired: 1000000 + 1300000 = 2300000ms
  const process2Time = initialOpenedAt + 1300000;
  const { MemoryRouter } = await import("../lib/memory-router/router.js");

  const mockFetch = async () => {
    throw new Error("Laya server still down on probe");
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    resetTimeout: resetTimeoutMs
  }, {
    useCache: true,
    cachePath,
    fs: mockFs,
    fetch: mockFetch,
    clock: () => process2Time
  });

  // Verify hydrated state before call
  assert.equal(router.circuitBreaker.getState().state, "OPEN");
  assert.equal(router.circuitBreaker.getState().backoffMultiplier, 4);

  // Evaluate query: canAttempt() transitions OPEN -> HALF_OPEN (probe slot claimed)
  // Probe executes and fails -> breaker transitions back to OPEN with doubled multiplier min(4*2, 6) = 6!
  const res = await router.evaluateRecall("Ambiguous query");
  assert.equal(res.recallRecommended, false);

  assert.equal(router.circuitBreaker.getState().state, "OPEN");
  assert.equal(router.circuitBreaker.getState().backoffMultiplier, 6, "Multiplier must increase from 4 to 6");

  // Verify updated state was persisted to cache
  const cachedData = readStateCache(cachePath, { fs: mockFs, now: process2Time });
  const epEntry = getEndpointCache(cachedData, "http://127.0.0.1:18791", {
    now: process2Time,
    resetTimeoutMs
  });
  assert.equal(epEntry.circuitBreaker.state, "OPEN");
  assert.equal(epEntry.circuitBreaker.backoffMultiplier, 6);

  router.dispose();
});

test("readStateCache rejects nested token and prompt fields, and writeStateCache never preserves or rewrites them", () => {
  // 1. Nested token under endpoint
  const nestedTokenFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 200 }),
    readFileSync: () => JSON.stringify({
      version: 1,
      endpoints: {
        "http://127.0.0.1:18791": {
          token: "nested-secret-bearer-token",
          circuitBreaker: { state: "CLOSED" }
        }
      }
    })
  };
  assert.equal(readStateCache("/cache.json", { fs: nestedTokenFs }), null, "Cache with nested token must return null");

  // 2. Nested prompt under endpoint
  const nestedPromptFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 200 }),
    readFileSync: () => JSON.stringify({
      version: 1,
      endpoints: {
        "http://127.0.0.1:18791": {
          prompt: "how to hack vault",
          health: { status: "ok" }
        }
      }
    })
  };
  assert.equal(readStateCache("/cache.json", { fs: nestedPromptFs }), null, "Cache with nested prompt must return null");

  // 3. writeStateCache with dirty payload containing sensitive keys is rejected (returns false)
  let writtenData = null;
  const mockFs = {
    existsSync: () => false,
    mkdirSync: () => {},
    writeFileSync: (p, data) => { writtenData = data; },
    renameSync: () => {},
    unlinkSync: () => {}
  };

  const dirtyPayloadResult = writeStateCache("/cache.json", {
    circuitBreaker: { state: "CLOSED" },
    token: "leaked_token"
  }, {
    endpoint: "http://127.0.0.1:18791",
    fs: mockFs
  });
  assert.equal(dirtyPayloadResult, false, "writeStateCache must reject payload containing token");
  assert.equal(writtenData, null);

  // 4. writeStateCache only writes strictly whitelisted fields and drops unknown properties
  let cleanWrittenData = null;
  const mockFs2 = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 200 }),
    // Existing cache with extra unknown field
    readFileSync: () => JSON.stringify({
      version: 1,
      updatedAt: 1000,
      unknownRootProp: "drop_me",
      endpoints: {
        "http://127.0.0.1:18791": {
          unknownEntryProp: "drop_me_too",
          circuitBreaker: { state: "CLOSED", consecutiveFailures: 0, extra: "bad" }
        }
      }
    }),
    mkdirSync: () => {},
    writeFileSync: (p, data) => { cleanWrittenData = data; },
    renameSync: () => {},
    unlinkSync: () => {}
  };

  const ok = writeStateCache("/cache.json", {
    health: { status: "ok", modelStatus: "ready" }
  }, {
    endpoint: "http://127.0.0.1:18791",
    fs: mockFs2,
    now: 2000
  });
  assert.equal(ok, true);
  const parsedWritten = JSON.parse(cleanWrittenData);
  assert.equal(parsedWritten.unknownRootProp, undefined, "unknownRootProp must be dropped");
  assert.equal(parsedWritten.endpoints["http://127.0.0.1:18791"].unknownEntryProp, undefined, "unknownEntryProp must be dropped");
  assert.equal(parsedWritten.endpoints["http://127.0.0.1:18791"].circuitBreaker.extra, undefined, "extra cb prop must be dropped");
  assert.equal(parsedWritten.endpoints["http://127.0.0.1:18791"].health.status, "ok");
});

test("Polluted cache with status='evil' or modelStatus='evil' is discarded, cannot set healthChecked=true, and first call must request /health", async () => {
  const pollutedCacheJson = JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    endpoints: {
      "http://127.0.0.1:18791": {
        circuitBreaker: {
          state: "CLOSED",
          consecutiveFailures: 0,
          openedAt: 0,
          backoffMultiplier: 1,
          permanentFailure: "false" // String "false", must not become boolean true
        },
        health: {
          status: "evil",
          modelStatus: "evil",
          checkedAt: Date.now()
        }
      }
    }
  });

  const mockFs = {
    existsSync: () => true,
    statSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: pollutedCacheJson.length }),
    readFileSync: () => pollutedCacheJson
  };

  // 1. Verify readStateCache and getEndpointCache discard polluted health and do not coerce permanentFailure to true
  const cached = readStateCache("/cache.json", { fs: mockFs });
  assert.ok(cached);
  const ep = getEndpointCache(cached, "http://127.0.0.1:18791");
  assert.ok(ep);
  assert.equal(ep.health, null, "Polluted health with evil status/modelStatus must be discarded (null)");
  assert.equal(ep.circuitBreaker.permanentFailure, false, "String 'false' must not become boolean true");

  // 2. Instantiate MemoryRouter with this polluted cache
  const fetchedUrls = [];
  const mockFetch = async (url) => {
    const urlStr = String(url);
    fetchedUrls.push(urlStr);
    if (urlStr.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          capabilities: ["recall"],
          model_status: "ready"
        })
      };
    }
    if (urlStr.endsWith("/judge/recall")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          requires_memory: 0.85,
          confidence: 0.95,
          scope: { project: 0.9 }
        })
      };
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const { MemoryRouter } = await import("../lib/memory-router/router.js");
  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791"
  }, {
    useCache: true,
    cachePath: "/cache.json",
    fs: mockFs,
    fetch: mockFetch
  });

  // Must NOT have set healthChecked to true from polluted cache!
  assert.equal(router.healthChecked, false, "Polluted cache must not set healthChecked=true");

  // First business call
  const res = await router.evaluateRecall("How to optimize SQL query?");
  assert.equal(res.recallRecommended, true);

  // MUST have called /health first before /judge/recall
  assert.equal(fetchedUrls.length, 2);
  assert.ok(fetchedUrls[0].endsWith("/health"), "First request MUST be /health handshake");
  assert.ok(fetchedUrls[1].endsWith("/judge/recall"), "Second request is /judge/recall");

  router.dispose();
});

test("Cache sanitization and writeStateCache clamp backoffMultiplier to MAX_BACKOFF_MULTIPLIER (6)", () => {
  const now = Date.now();
  const pollutedCacheJson = JSON.stringify({
    version: 1,
    updatedAt: now,
    endpoints: {
      "http://127.0.0.1:18791": {
        circuitBreaker: {
          state: "OPEN",
          consecutiveFailures: 3,
          openedAt: now,
          backoffMultiplier: 64, // Over limit
          permanentFailure: false
        }
      }
    }
  });

  let writtenFiles = {};
  const mockFs = {
    existsSync: (p) => Boolean(writtenFiles[p]) || p === "/cache.json",
    statSync: (p) => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: (writtenFiles[p] ?? pollutedCacheJson).length
    }),
    readFileSync: (p) => writtenFiles[p] ?? pollutedCacheJson,
    mkdirSync: () => {},
    unlinkSync: () => {},
    writeFileSync: (p, content) => {
      writtenFiles[p] = content;
    },
    renameSync: (from, to) => {
      writtenFiles[to] = writtenFiles[from];
      delete writtenFiles[from];
    }
  };

  // 1. readStateCache clamps backoffMultiplier <= 6
  const cached = readStateCache("/cache.json", { fs: mockFs });
  assert.ok(cached);
  const ep = getEndpointCache(cached, "http://127.0.0.1:18791", { now });
  assert.ok(ep);
  assert.equal(ep.circuitBreaker.backoffMultiplier, 1, "Excessive backoffMultiplier (>6) in raw cache is rejected to default 1");

  // 2. writeStateCache clamps excessive backoffMultiplier to MAX_BACKOFF_MULTIPLIER (6)
  writeStateCache("/cache.json", {
    circuitBreaker: {
      state: "OPEN",
      consecutiveFailures: 3,
      openedAt: now,
      backoffMultiplier: 64
    }
  }, {
    endpoint: "http://127.0.0.1:18791",
    fs: mockFs,
    platform: "linux",
    now
  });

  const updated = readStateCache("/cache.json", { fs: mockFs });
  const updatedEp = getEndpointCache(updated, "http://127.0.0.1:18791", { now });
  assert.equal(updatedEp.circuitBreaker.backoffMultiplier, 6, "writeStateCache clamps backoffMultiplier to 6");
});

