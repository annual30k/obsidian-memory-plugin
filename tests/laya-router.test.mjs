import test from "node:test";
import assert from "node:assert/strict";
import { MemoryRouter } from "../lib/memory-router/router.js";
import { CircuitState } from "../lib/memory-router/circuit-breaker.js";

const VALID_HEALTH_JSON = JSON.stringify({
  service: "laya-memory-judge",
  status: "ok",
  api_version: "1",
  model_status: "ready",
  capabilities: ["recall", "scope"]
});

const VALID_RECALL_JSON = JSON.stringify({
  requires_memory: 0.85,
  confidence: 0.95,
  scope: { project: 0.9 }
});

test("MemoryRouter mode off performs zero network calls", async () => {
  let networkCalls = 0;
  const mockFetch = async () => {
    networkCalls++;
    return { ok: true, status: 200, text: async () => "{}" };
  };

  const router = new MemoryRouter({ mode: "off" }, { fetch: mockFetch });
  const result = await router.evaluateRecall("Some ambiguous question that would otherwise trigger Laya");

  assert.equal(networkCalls, 0);
  assert.equal(result.recallRecommended, false);
  assert.equal(result.reason, "mode_off");
  router.dispose();
});

test("MemoryRouter mode manual calls /health on first call and only /judge/recall subsequently", async () => {
  let healthCalls = 0;
  let recallCalls = 0;

  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/health")) {
      healthCalls++;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => VALID_HEALTH_JSON
      };
    }
    if (urlStr.endsWith("/judge/recall")) {
      recallCalls++;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => VALID_RECALL_JSON
      };
    }
    return { ok: false, status: 404, text: async () => "" };
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    recallThreshold: 0.70
  }, { fetch: mockFetch });

  // 1. First business query: executes 1 health + 1 recall
  const res1 = await router.evaluateRecall("How should I configure the gateway?");
  assert.equal(healthCalls, 1, "First query must perform initial health handshake");
  assert.equal(recallCalls, 1);
  assert.equal(res1.recallRecommended, true);
  assert.equal(res1.score, 0.85);
  assert.equal(res1.scope, "project");

  // 2. Second business query: does NOT call /health again!
  const res2 = await router.evaluateRecall("Another architecture question?");
  assert.equal(healthCalls, 1, "Subsequent query must NOT repeat health handshake");
  assert.equal(recallCalls, 2);
  assert.equal(res2.recallRecommended, true);

  // 3. Fast-path hit: 0 network calls
  const fastResult = await router.evaluateRecall("你好！");
  assert.equal(healthCalls, 1);
  assert.equal(recallCalls, 2);
  assert.equal(fastResult.recallRecommended, false);
  assert.equal(fastResult.reason, "trivial_greeting");

  router.dispose();
});

test("MemoryRouter auto mode fast-fallbacks when discovery timer is active, and unrefs timer", async () => {
  let discoveryCount = 0;
  let timerUnrefCalled = false;
  let timerCleared = false;
  let intervalCallback = null;

  const mockFs = {
    existsSync: () => false,
    readFileSync: () => ""
  };

  const mockTimers = {
    setInterval: (cb, ms) => {
      intervalCallback = cb;
      return {
        unref: () => { timerUnrefCalled = true; }
      };
    },
    clearInterval: () => {
      timerCleared = true;
    }
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json",
    discoveryInterval: 60000
  }, {
    fs: mockFs,
    timers: mockTimers
  });

  // Since service wasn't found at init, discovery timer was started and unreferenced
  assert.equal(timerUnrefCalled, true);

  // When timer is running, evaluateRecall does NOT re-run discovery synchronously
  const res = await router.evaluateRecall("Some ambiguous question");
  assert.equal(res.recallRecommended, false);
  assert.equal(res.reason, "no_trusted_service");

  // router.dispose() clears the timer
  router.dispose();
  assert.equal(timerCleared, true);
});

test("Auto mode: permanent 401 failure keeps discovery timer alive, next interval makes 0 network calls on same identity, probes only B after service switch, and business success stops timer", async () => {
  let timerCleared = false;
  let timerCallback = null;
  const mockTimers = {
    setInterval: (cb) => {
      timerCallback = cb;
      return { unref: () => {} };
    },
    clearInterval: () => { timerCleared = true; }
  };

  let currentEndpoint = "http://127.0.0.1:18791";
  let hasFile = false;
  const mockFs = {
    existsSync: () => hasFile,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: currentEndpoint,
      api_version: "1"
    })
  };

  const fetchedUrls = [];
  const mockFetch = async (url) => {
    const urlStr = String(url);
    fetchedUrls.push(urlStr);
    if (urlStr.includes("18791")) {
      // Endpoint A returns 401 Unauthorized (permanent error)
      return {
        ok: false,
        status: 401,
        headers: new Map(),
        text: async () => "Unauthorized"
      };
    }
    if (urlStr.includes("19999")) {
      // Endpoint B returns healthy responses
      if (urlStr.endsWith("/health")) {
        return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
      }
      if (urlStr.endsWith("/judge/recall")) {
        return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
      }
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json"
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch,
    timers: mockTimers
  });

  // Discovery timer started because service was not found yet
  assert.ok(router.discoveryTimer);
  assert.ok(timerCallback);

  // 1. Service file appears pointing to A (18791). Timer fires real 401 probe
  hasFile = true;
  await timerCallback();

  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);
  assert.equal(router.circuitBreaker.getState().permanentFailure, true);
  // Real 401 MUST keep discovery timer alive so subsequent changes to service.json can be discovered!
  assert.equal(timerCleared, false, "Discovery timer must remain alive on permanent failure in auto mode");
  assert.ok(router.discoveryTimer);
  assert.equal(fetchedUrls.length, 1);
  assert.ok(fetchedUrls[0].includes("18791/health"));

  // 2. Next interval: service file still points to A with same identity -> 0 network calls!
  await timerCallback();
  assert.equal(fetchedUrls.length, 1, "Next interval with same identity must make 0 network requests");

  // 3. Service file switches to B (19999)
  currentEndpoint = "http://127.0.0.1:19999";
  await timerCallback();

  // New identity discovered! Breaker was reset, probed ONLY B, and completed health check
  assert.equal(fetchedUrls.length, 2);
  assert.ok(fetchedUrls[1].includes("19999/health"), "Must probe only endpoint B");
  assert.equal(router.client.endpoint, "http://127.0.0.1:19999");
  assert.equal(router.healthChecked, true);

  // 4. Successful business query evaluates recall and then stops the now-unneeded discovery timer
  const res = await router.evaluateRecall("Some user query");
  assert.equal(res.recallRecommended, true);
  assert.equal(timerCleared, true, "Successful business turn must stop unneeded discovery timer");
  assert.equal(router.discoveryTimer, null);

  router.dispose();
});

test("MemoryRouter falls back and trips circuit breaker on consecutive health/recall failures", async () => {
  let attempts = 0;
  const mockFetch = async () => {
    attempts++;
    throw new Error("Connection refused");
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    consecutiveFailures: 2,
    resetTimeout: 60000
  }, { fetch: mockFetch });

  // Call 1: health fails, fallback
  const res1 = await router.evaluateRecall("Question 1");
  assert.equal(res1.recallRecommended, false);
  assert.equal(res1.reason, "health_handshake_failed");
  assert.equal(attempts, 1);

  // Call 2: health fails again, trips breaker to OPEN
  const res2 = await router.evaluateRecall("Question 2");
  assert.equal(res2.recallRecommended, false);
  assert.equal(res2.reason, "health_handshake_failed");
  assert.equal(attempts, 2);

  // Call 3: Breaker is OPEN -> fails fast without network attempt
  const res3 = await router.evaluateRecall("Question 3");
  assert.equal(res3.recallRecommended, false);
  assert.equal(res3.reason, "circuit_breaker_open");
  assert.equal(attempts, 2); // Did not increment!

  router.dispose();
});

test("Discovery interval respects OPEN cooldown and makes 0 network calls during cooldown", async () => {
  let currentTime = 10000;
  let intervalCb = null;
  let fetchCount = 0;

  const mockTimers = {
    setInterval: (cb) => { intervalCb = cb; return { unref: () => {} }; },
    clearInterval: () => {}
  };

  const serviceJson = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1"
  });

  let hasService = false;
  const mockFs = {
    existsSync: () => hasService,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: serviceJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => serviceJson
  };

  const mockFetch = async () => {
    fetchCount++;
    throw new Error("Temporary network glitch");
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json",
    consecutiveFailures: 2,
    resetTimeout: 5000
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch,
    timers: mockTimers,
    clock: () => currentTime
  });

  // Discovery timer started because service was not present initially
  assert.ok(intervalCb);

  // Now service file appears
  hasService = true;

  // Step 1: Force breaker to OPEN via 2 consecutive timer failures
  await intervalCb();
  await intervalCb();
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);
  assert.equal(fetchCount, 2);

  // Step 2: Advance time by 2000ms (still within 5000ms cooldown)
  currentTime += 2000;
  // Trigger interval callback
  await intervalCb();
  // MUST NOT make any network calls!
  assert.equal(fetchCount, 2, "Discovery timer MUST NOT make network calls during OPEN cooldown");

  // Step 3: Advance time beyond 5000ms cooldown (e.g. +4000ms -> 6000ms total)
  currentTime += 4000;
  // Trigger interval callback -> now canAttempt() transitions to HALF_OPEN and allows 1 probe
  await intervalCb();
  assert.equal(fetchCount, 3, "Discovery timer should probe once cooldown expires");

  router.dispose();
});

test("HALF_OPEN probe failing on judgeRecall immediately re-opens breaker with doubled backoff", async () => {
  let currentTime = 10000;
  let healthCount = 0;
  let recallCount = 0;

  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/health")) {
      healthCount++;
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
    }
    if (urlStr.endsWith("/judge/recall")) {
      recallCount++;
      throw new Error("Laya model crashed during inference");
    }
    throw new Error("Not found");
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    consecutiveFailures: 1,
    resetTimeout: 5000
  }, {
    fetch: mockFetch,
    clock: () => currentTime
  });

  // Initial failure -> breaker OPEN (multiplier 1)
  await router.evaluateRecall("Query 1");
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);
  assert.equal(router.circuitBreaker.getState().backoffMultiplier, 1);

  // Advance time past cooldown -> transitions to HALF_OPEN
  currentTime += 6000;

  // Next query: healthCheck succeeds, but judgeRecall fails!
  const res = await router.evaluateRecall("Query 2");
  assert.equal(res.recallRecommended, false);

  // Breaker must be immediately OPEN with backoffMultiplier = 2 (not reset to CLOSED!)
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);
  assert.equal(router.circuitBreaker.getState().backoffMultiplier, 2, "Backoff multiplier must double on HALF_OPEN judge failure");

  router.dispose();
});

test("Consecutive failure count carries over across health and judge failures", async () => {
  let callIndex = 0;
  const mockFetch = async (url) => {
    callIndex++;
    const urlStr = String(url);
    if (callIndex === 1 && urlStr.endsWith("/health")) {
      throw new Error("Handshake 1 error"); // Failure 1
    }
    if (callIndex === 2 && urlStr.endsWith("/health")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
    }
    if (callIndex === 3 && urlStr.endsWith("/judge/recall")) {
      throw new Error("Judge failure"); // Failure 2
    }
    throw new Error("Unexpected");
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    consecutiveFailures: 2,
    resetTimeout: 60000
  }, { fetch: mockFetch });

  // Round 1: health fails (failure 1)
  await router.evaluateRecall("Query 1");
  assert.equal(router.circuitBreaker.getState().consecutiveFailures, 1);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.CLOSED);

  // Round 2: health succeeds, but judge fails (failure 2)
  await router.evaluateRecall("Query 2");
  // Breaker must trip to OPEN on second failure!
  assert.equal(router.circuitBreaker.getState().consecutiveFailures, 2);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);

  router.dispose();
});

test("Auto mode endpoint change from A to B resets health identity and breaker without pollution", async () => {
  let currentEndpoint = "http://127.0.0.1:18791";
  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: currentEndpoint,
      api_version: "1"
    })
  };

  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("18791")) {
      if (urlStr.endsWith("/health")) {
        return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
      }
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    // Endpoint B fails
    throw new Error("Endpoint B unreachable");
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json"
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch
  });

  // Query on endpoint A succeeds and completes health handshake
  const resA = await router.evaluateRecall("Query A");
  assert.equal(resA.recallRecommended, true);
  assert.equal(router.healthChecked, true);
  assert.equal(router.client.endpoint, "http://127.0.0.1:18791");

  // Now change service file to endpoint B and trigger discovery (as discovery timer would)
  currentEndpoint = "http://127.0.0.1:19999";
  router._discoverAutoEndpoint();

  assert.equal(router.client.endpoint, "http://127.0.0.1:19999");
  // Health checked must be reset to false for the new endpoint!
  assert.equal(router.healthChecked, false);

  // Next query on endpoint B must trigger health check on B, which fails
  const resB = await router.evaluateRecall("Query B");
  assert.equal(resB.recallRecommended, false);
  assert.equal(resB.reason, "health_handshake_failed");

  router.dispose();
});

test("model_status=loading uses coldStartTimeout", async () => {
  let receivedTimeout = null;
  const mockFetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "loading", // Cold start!
          capabilities: ["recall"]
        })
      };
    }
    if (urlStr.endsWith("/judge/recall")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    throw new Error("404");
  };

  const mockTimers = {
    setTimeout: (_fn, ms) => { receivedTimeout = ms; return { id: 1 }; },
    clearTimeout: () => {}
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    timeout: 1000,
    coldStartTimeout: 5500
  }, {
    fetch: mockFetch,
    timers: mockTimers
  });

  await router.evaluateRecall("Question about cold start");
  // Must have used coldStartTimeout 5500, not 1000
  assert.equal(receivedTimeout, 5500, "model_status=loading must use coldStartTimeout");

  router.dispose();
});

test("long-lived router uses coldStartTimeout after the server idle-unload window", async () => {
  let now = 100000;
  let receivedTimeout = null;
  let healthCalls = 0;
  const mockFetch = async (url) => {
    if (String(url).endsWith("/health")) {
      healthCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          idle_unload_seconds: 10,
          capabilities: ["recall"]
        })
      };
    }
    if (String(url).endsWith("/judge/recall")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    throw new Error("404");
  };
  const mockTimers = {
    setTimeout: (_fn, ms) => { receivedTimeout = ms; return { id: 1 }; },
    clearTimeout: () => {},
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {}
  };
  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18792",
    timeout: 1000,
    coldStartTimeout: 5500
  }, {
    fetch: mockFetch,
    timers: mockTimers,
    clock: () => now
  });

  await router.evaluateRecall("An ambiguous first request");
  assert.equal(receivedTimeout, 1000);
  now += 10001;
  await router.evaluateRecall("Another ambiguous request after idle");
  assert.equal(receivedTimeout, 5500, "idle model reload must use coldStartTimeout");
  assert.equal(healthCalls, 1, "long-lived router infers cold state without probing health every turn");
  router.dispose();
});

test("Auth failures 401/403 log warn without reflecting token or raw response body", async () => {
  const warnLogs = [];
  const mockLogger = {
    warn: (msg) => warnLogs.push(msg),
    debug: () => {}
  };

  const mockFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "Secret server leak with sensitive internal trace"
  });

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791"
  }, {
    fetch: mockFetch,
    logger: mockLogger
  });

  await router.evaluateRecall("Some question");
  assert.equal(warnLogs.length, 1);
  assert.ok(warnLogs[0].includes("Authentication failed"));
  assert.ok(!warnLogs[0].includes("Secret server leak"), "Must not reflect raw body in warn log");

  router.dispose();
});

test("Interval callback: permanent OPEN on endpoint A switches to B, discovers B, and probes only B", async () => {
  let currentEndpoint = "http://127.0.0.1:18791";
  let intervalCb = null;
  const mockTimers = {
    setInterval: (cb) => { intervalCb = cb; return { unref: () => {} }; },
    clearInterval: () => {}
  };

  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: currentEndpoint,
      api_version: "1"
    })
  };

  const fetchedUrls = [];
  const mockFetch = async (url) => {
    const urlStr = String(url);
    fetchedUrls.push(urlStr);
    if (urlStr.includes("18791")) {
      throw new Error("Endpoint A down");
    }
    if (urlStr.includes("19999")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
    }
    throw new Error("Unknown endpoint");
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json"
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch,
    timers: mockTimers
  });

  // Trip A's breaker to permanent OPEN
  router.circuitBreaker.recordFailure({ permanent: true });
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);
  assert.equal(router.circuitBreaker.getState().permanentFailure, true);
  assert.equal(router.circuitBreaker.canAttempt(), false);

  // Clear fetchedUrls
  fetchedUrls.length = 0;

  // Now switch service.json from A (18791) to B (19999)
  currentEndpoint = "http://127.0.0.1:19999";

  // Trigger the REAL discovery timer interval callback
  await intervalCb();

  // Assert:
  // 1. service.json was read and endpoint switched to B
  assert.equal(router.endpoint, "http://127.0.0.1:19999");
  assert.equal(router.client.endpoint, "http://127.0.0.1:19999");
  // 2. Breaker for B was reset and allowed health check
  assert.equal(router.healthChecked, true);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.CLOSED);
  // 3. Network calls: ONLY B was probed! A was NEVER probed!
  assert.equal(fetchedUrls.length, 1);
  assert.ok(fetchedUrls[0].includes("19999/health"), "Only endpoint B must be probed");
  assert.ok(!fetchedUrls.some(u => u.includes("18791")), "Endpoint A must NEVER be probed when permanent OPEN");

  router.dispose();
});

test("Interval callback: cooldown expires but service file is missing, does not claim probe or deadlock HALF_OPEN, and probes after file is restored", async () => {
  let currentTime = 10000;
  let intervalCb = null;
  let fetchCount = 0;
  let hasFile = true;

  const mockTimers = {
    setInterval: (cb) => { intervalCb = cb; return { unref: () => {} }; },
    clearInterval: () => {}
  };

  const serviceJson = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1"
  });

  const mockFs = {
    existsSync: () => hasFile,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: serviceJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => serviceJson
  };

  const mockFetch = async () => {
    fetchCount++;
    return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json",
    consecutiveFailures: 2,
    resetTimeout: 5000
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch,
    timers: mockTimers,
    clock: () => currentTime
  });

  // Step 1: Put breaker into OPEN state
  router.circuitBreaker.recordFailure();
  router.circuitBreaker.recordFailure();
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN);
  fetchCount = 0;

  // Step 2: Cooldown expires (advance clock by 6000ms > 5000ms cooldown)
  currentTime += 6000;

  // BUT service.json is missing!
  hasFile = false;

  // Run discovery timer interval callback
  await intervalCb();

  // Assert:
  // Breaker must NOT transition to HALF_OPEN and must NOT claim halfOpenProbeInFlight
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN, "Breaker must stay OPEN when service file is absent");
  assert.equal(router.circuitBreaker.halfOpenProbeInFlight, false, "halfOpenProbeInFlight must NOT be claimed");
  assert.equal(fetchCount, 0, "No network request when service file is absent");

  // Step 3: Later, service file is restored
  hasFile = true;
  currentTime += 1000;

  // Run discovery timer interval callback again
  await intervalCb();

  // Assert:
  // It successfully claimed the probe, made the health call, and closed breaker
  assert.equal(fetchCount, 1, "Should probe once service file is restored");
  assert.equal(router.healthChecked, true);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.CLOSED);

  router.dispose();
});

test("Auto mode: health success -> judge fails to OPEN -> timer makes 0 network calls before and after cooldown without deadlocking HALF_OPEN -> next user request executes judge probe and closes breaker", async () => {
  let currentTime = 10000;
  let intervalCb = null;

  const mockTimers = {
    setInterval: (cb) => { intervalCb = cb; return { unref: () => {} }; },
    clearInterval: () => { intervalCb = null; }
  };

  let healthCallCount = 0;
  let judgeCallCount = 0;
  let judgeShouldFail = false;

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/health")) {
      healthCallCount++;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => VALID_HEALTH_JSON
      };
    }
    if (u.includes("/judge/recall")) {
      judgeCallCount++;
      if (judgeShouldFail) {
        return {
          ok: false,
          status: 500,
          headers: new Map(),
          text: async () => "Internal Server Error"
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => VALID_RECALL_JSON
      };
    }
    throw new Error("Unexpected URL: " + u);
  };

  const serviceJson = JSON.stringify({
    service: "laya-memory-judge",
    endpoint: "http://127.0.0.1:18791",
    api_version: "1"
  });

  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: serviceJson.length }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => serviceJson
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json",
    consecutiveFailures: 2,
    resetTimeout: 5000
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch,
    timers: mockTimers,
    clock: () => currentTime
  });

  // Step 1: Initial business request succeeds (healthChecked = true, judge succeeds, breaker CLOSED)
  const res1 = await router.evaluateRecall("Remember user preferences");
  assert.equal(res1.recallRecommended, true);
  assert.equal(healthCallCount, 1, "Initial /health handshake performed");
  assert.equal(judgeCallCount, 1, "Initial /judge/recall performed");
  assert.equal(router.healthChecked, true);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.CLOSED);
  assert.equal(router.discoveryTimer, null, "Discovery timer not running while healthy");

  // Step 2: Next two judge requests fail, tripping the breaker to OPEN
  judgeShouldFail = true;

  const res2 = await router.evaluateRecall("Some task two");
  assert.equal(res2.recallRecommended, false);
  assert.equal(judgeCallCount, 2);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.CLOSED, "First failure does not trip threshold=2");

  const res3 = await router.evaluateRecall("Some task three");
  assert.equal(res3.recallRecommended, false);
  assert.equal(judgeCallCount, 3);
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN, "Second failure trips breaker to OPEN");
  assert.equal(router.healthChecked, true, "Health was previously verified");
  assert.ok(router.discoveryTimer !== null, "Discovery timer started on breaker OPEN");
  assert.ok(intervalCb !== null, "Interval callback registered");

  // Step 3: Discovery timer fires BEFORE cooldown expires (2000ms < 5000ms)
  currentTime += 2000;
  const healthCallsBefore1 = healthCallCount;
  const judgeCallsBefore1 = judgeCallCount;

  await intervalCb();

  assert.equal(healthCallCount, healthCallsBefore1, "0 network health calls during OPEN before cooldown");
  assert.equal(judgeCallCount, judgeCallsBefore1, "0 network judge calls during OPEN before cooldown");
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN, "Breaker must stay OPEN");
  assert.equal(router.circuitBreaker.halfOpenProbeInFlight, false, "halfOpenProbeInFlight must NOT be set by timer");
  assert.ok(router.discoveryTimer !== null, "Discovery timer keeps running");

  // Step 4: Discovery timer fires AFTER cooldown expires (currentTime advanced by 4000ms, total 6000ms > 5000ms)
  // Crucial check: Since healthChecked === true, the timer must NOT claim canAttempt() or transition breaker to HALF_OPEN!
  currentTime += 4000;
  const healthCallsBefore2 = healthCallCount;
  const judgeCallsBefore2 = judgeCallCount;

  await intervalCb();

  assert.equal(healthCallCount, healthCallsBefore2, "0 network health calls during OPEN after cooldown");
  assert.equal(judgeCallCount, judgeCallsBefore2, "0 network judge calls during OPEN after cooldown");
  assert.equal(router.circuitBreaker.getState().state, CircuitState.OPEN, "Breaker must remain OPEN, NOT transitioned by timer");
  assert.equal(router.circuitBreaker.halfOpenProbeInFlight, false, "halfOpenProbeInFlight must NOT be claimed by timer");
  assert.ok(router.discoveryTimer !== null, "Discovery timer must NOT be stopped prematurely");

  // Step 5: A real user request comes in. It CAN attempt the recovery probe!
  judgeShouldFail = false; // Remote judge service has recovered
  const res4 = await router.evaluateRecall("User query after recovery");

  // User request must succeed!
  assert.equal(res4.recallRecommended, true);
  assert.equal(healthCallCount, healthCallsBefore2, "No redundant /health call since health was already verified");
  assert.equal(judgeCallCount, judgeCallsBefore2 + 1, "User turn executes the /judge/recall probe");
  assert.equal(router.circuitBreaker.getState().state, CircuitState.CLOSED, "Breaker is now closed");
  assert.equal(router.discoveryTimer, null, "Discovery timer is stopped upon successful business turn");

  router.dispose();
});

test("Concurrent initial evaluateRecall calls deduplicate health handshake to a single /health request", async () => {
  let healthCallCount = 0;
  let judgeCallCount = 0;

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes("/health")) {
      healthCallCount++;
      // Simulate slight network latency so both concurrent requests enter simultaneously
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
    }
    if (u.includes("/judge/recall")) {
      judgeCallCount++;
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    throw new Error("Unexpected URL: " + u);
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791"
  }, {
    fetch: mockFetch
  });

  // Launch two concurrent business turns on unverified initial state
  const [res1, res2] = await Promise.all([
    router.evaluateRecall("Concurrent query one"),
    router.evaluateRecall("Concurrent query two")
  ]);

  assert.equal(res1.recallRecommended, true);
  assert.equal(res2.recallRecommended, true);
  assert.equal(healthCallCount, 1, "Exactly one /health check must be sent across concurrent requests");
  assert.equal(judgeCallCount, 2, "Both business judge calls execute");

  router.dispose();
});

test("Regression: deferred health handshake for endpoint A discarded when switched to B, no B judge/recall in turn 1, and turn 2 checks B health", async () => {
  let currentEndpoint = "http://127.0.0.1:18791";
  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: currentEndpoint,
      api_version: "1"
    })
  };

  const calledUrls = [];
  let resolveAHealth;
  const aHealthPromise = new Promise((resolve) => {
    resolveAHealth = resolve;
  });

  const mockFetch = async (url) => {
    const u = String(url);
    calledUrls.push(u);
    if (u.includes("18791/health")) {
      await aHealthPromise;
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
    }
    if (u.includes("18791/judge/recall")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    if (u.includes("19999/health")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
    }
    if (u.includes("19999/judge/recall")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    throw new Error("Unexpected URL: " + u);
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json"
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch
  });

  // Turn 1: evaluateRecall on endpoint A starts /health on A (which hangs on aHealthPromise)
  const turn1Promise = router.evaluateRecall("Query for endpoint A");

  // While A's /health is in flight, service.json switches to B
  currentEndpoint = "http://127.0.0.1:19999";
  router._discoverAutoEndpoint();

  assert.equal(router.endpoint, "http://127.0.0.1:19999");
  assert.equal(router.client.endpoint, "http://127.0.0.1:19999");
  assert.equal(router.healthChecked, false);

  // Now resolve A's /health
  resolveAHealth();
  const res1 = await turn1Promise;

  // Turn 1 must safely fallback and discard A's health result
  assert.equal(res1.recallRecommended, false);
  assert.equal(res1.reason, "health_handshake_failed");
  assert.equal(router.healthChecked, false, "Endpoint B must NOT be marked healthChecked by endpoint A's completed handshake");

  // Endpoint B's /judge/recall must NEVER have been called!
  assert.equal(calledUrls.includes("http://127.0.0.1:19999/judge/recall"), false, "Must NOT execute B /judge/recall when A health completes");
  assert.deepEqual(calledUrls, ["http://127.0.0.1:18791/health"]);

  // Turn 2: next user query must initiate /health for endpoint B before calling B's /judge/recall
  const res2 = await router.evaluateRecall("Query for endpoint B");

  assert.equal(res2.recallRecommended, true);
  assert.equal(router.healthChecked, true, "Endpoint B is now legitimately healthChecked");
  assert.deepEqual(calledUrls, [
    "http://127.0.0.1:18791/health",
    "http://127.0.0.1:19999/health",
    "http://127.0.0.1:19999/judge/recall"
  ]);

  router.dispose();
});

test("Regression: deferred health handshake for token A discarded when token switches to B, and turn 2 checks token B health", async () => {
  let currentToken = "token-aaa";
  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      token: currentToken,
      api_version: "1"
    })
  };

  const calledRequests = [];
  let resolveTokenAHealth;
  const tokenAHealthPromise = new Promise((resolve) => {
    resolveTokenAHealth = resolve;
  });

  const mockFetch = async (url, opts = {}) => {
    const u = String(url);
    const authHeader = opts.headers?.["Authorization"] || opts.headers?.get?.("Authorization") || null;
    calledRequests.push({ url: u, auth: authHeader });
    if (u.endsWith("/health")) {
      if (authHeader === "Bearer token-aaa") {
        await tokenAHealthPromise;
        return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
      }
      if (authHeader === "Bearer token-bbb") {
        return { ok: true, status: 200, headers: new Map(), text: async () => VALID_HEALTH_JSON };
      }
    }
    if (u.endsWith("/judge/recall")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    throw new Error("Unexpected request: " + u + " with auth " + authHeader);
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json"
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    fetch: mockFetch
  });

  // Turn 1 starts with token-aaa
  const turn1Promise = router.evaluateRecall("Query with token A");

  // While token A's /health is in flight, token switches to token-bbb
  currentToken = "token-bbb";
  router._discoverAutoEndpoint();

  assert.equal(router.client.token, "token-bbb");
  assert.equal(router.healthChecked, false);

  // Now resolve token A's /health
  resolveTokenAHealth();
  const res1 = await turn1Promise;

  assert.equal(res1.recallRecommended, false);
  assert.equal(res1.reason, "health_handshake_failed");
  assert.equal(router.healthChecked, false, "Client must NOT be marked healthChecked by token A's stale handshake");
  assert.equal(calledRequests.some(r => r.url.endsWith("/judge/recall")), false, "Must not call /judge/recall during turn 1");

  // Turn 2: next query must initiate /health with token-bbb
  const res2 = await router.evaluateRecall("Query with token B");

  assert.equal(res2.recallRecommended, true);
  assert.equal(router.healthChecked, true);

  assert.deepEqual(calledRequests, [
    { url: "http://127.0.0.1:18791/health", auth: "Bearer token-aaa" },
    { url: "http://127.0.0.1:18791/health", auth: "Bearer token-bbb" },
    { url: "http://127.0.0.1:18791/judge/recall", auth: "Bearer token-bbb" }
  ]);

  router.dispose();
});

test("MemoryRouter detects daemon restart on same port and token via instance_id / pid change, resetting health and breaker", async () => {
  let currentInstance = "inst-111";
  let currentPid = 1001;

  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      token: "same-token",
      instance_id: currentInstance,
      pid: currentPid,
      api_version: "1"
    })
  };

  let failCount = 0;
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          capabilities: ["recall"],
          instance_id: currentInstance
        })
      };
    }
    if (u.endsWith("/judge/recall")) {
      if (failCount > 0) {
        failCount--;
        return { ok: false, status: 500, headers: new Map(), text: async () => '{"error":"fail"}' };
      }
      return { ok: true, status: 200, headers: new Map(), text: async () => VALID_RECALL_JSON };
    }
    throw new Error("Unexpected request: " + u);
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json",
    consecutiveFailures: 2,
    resetTimeout: 60000
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    isPidRunning: () => true,
    fetch: mockFetch
  });

  // Turn 1: initial identity inst-111 succeeds
  const res1 = await router.evaluateRecall("Initial query");
  assert.equal(res1.recallRecommended, true);
  assert.equal(router.healthChecked, true);
  assert.equal(router.instanceId, "inst-111");
  assert.equal(router.pid, 1001);

  // Now simulate 2 failures to trip circuit breaker to OPEN
  failCount = 2;
  await router.evaluateRecall("Failing query 1");
  await router.evaluateRecall("Failing query 2");
  assert.equal(router.circuitBreaker.state, "OPEN");

  // Daemon restarts on the same loopback port and token, but with a new instance_id and pid!
  currentInstance = "inst-222";
  currentPid = 1002;
  const discovered = router._discoverAutoEndpoint();
  assert.equal(discovered, true);

  // Breaker and health identity MUST be reset for the new daemon instance!
  assert.equal(router.instanceId, "inst-222");
  assert.equal(router.pid, 1002);
  assert.equal(router.healthChecked, false, "healthChecked must be reset for new instance");
  assert.equal(router.circuitBreaker.state, "CLOSED", "Circuit breaker must be reset for new instance");

  // Next query executes health check on new instance and succeeds
  const res2 = await router.evaluateRecall("Query to restarted daemon");
  assert.equal(res2.recallRecommended, true);
  assert.equal(router.healthChecked, true);
  assert.equal(router.instanceId, "inst-222");

  router.dispose();
});

test("MemoryRouter _ensureHealthHandshake rejects health response if instance_id mismatches expected instance_id", async () => {
  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true, uid: 1000, mode: 0o100600, size: 200 }),
    statSync: () => ({ isFile: () => true }),
    readFileSync: () => JSON.stringify({
      service: "laya-memory-judge",
      endpoint: "http://127.0.0.1:18791",
      token: "tok-test",
      instance_id: "expected-inst-id",
      pid: 2000,
      api_version: "1"
    })
  };

  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          capabilities: ["recall"],
          instance_id: "mismatched-foreign-inst-id"
        })
      };
    }
    throw new Error("Unexpected request: " + u);
  };

  const router = new MemoryRouter({
    mode: "auto",
    serviceFile: "/path/to/service.json"
  }, {
    fs: mockFs,
    platform: "linux",
    getuid: () => 1000,
    isPidRunning: () => true,
    fetch: mockFetch
  });

  const res = await router.evaluateRecall("Query with mismatched health instance");
  assert.equal(res.recallRecommended, false);
  assert.equal(res.reason, "health_handshake_failed");
  assert.equal(router.healthChecked, false, "Handshake must be rejected when instance_id mismatches");

  router.dispose();
});

test("MemoryRouter evaluates proactive capture when model detects high-confidence pitfall", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          capabilities: ["recall"]
        })
      };
    }
    if (u.endsWith("/judge/recall")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          requires_memory: 0.15,
          confidence: 0.88,
          scope: { project: 0.95 },
          categories: { pitfall: 0.92, decision: 0.05, knowledge: 0.03 }
        })
      };
    }
    throw new Error("Unexpected request: " + u);
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    recallThreshold: 0.70,
    captureThreshold: 0.75,
    proactiveCapture: true
  }, { fetch: mockFetch });

  const res = await router.evaluateRecall("Some complex bug workaround discussion");
  assert.equal(res.recallRecommended, false);
  assert.equal(res.captureRecommended, true);
  assert.equal(res.captureCategory, "pitfall");
  assert.equal(res.reason, "laya_capture_recommended");
  assert.equal(res.scope, "project");

  router.dispose();
});

test("MemoryRouter evaluates proactive capture when model detects high-confidence decision", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          capabilities: ["recall"]
        })
      };
    }
    if (u.endsWith("/judge/recall")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          requires_memory: 0.20,
          confidence: 0.91,
          scope: { project: 0.90 },
          categories: { pitfall: 0.02, decision: 0.95, knowledge: 0.03 }
        })
      };
    }
    throw new Error("Unexpected request: " + u);
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    recallThreshold: 0.70,
    captureThreshold: 0.75,
    proactiveCapture: true
  }, { fetch: mockFetch });

  const res = await router.evaluateRecall("Architectural decision on backend implementation");
  assert.equal(res.recallRecommended, false);
  assert.equal(res.captureRecommended, true);
  assert.equal(res.captureCategory, "decision");
  assert.equal(res.reason, "laya_capture_recommended");

  router.dispose();
});

test("MemoryRouter disables proactive capture when proactiveCapture is false", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          capabilities: ["recall"]
        })
      };
    }
    if (u.endsWith("/judge/recall")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          requires_memory: 0.20,
          confidence: 0.95,
          scope: { project: 0.90 },
          categories: { pitfall: 0.01, decision: 0.96, knowledge: 0.03 }
        })
      };
    }
    throw new Error("Unexpected request: " + u);
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    recallThreshold: 0.70,
    captureThreshold: 0.75,
    proactiveCapture: false
  }, { fetch: mockFetch });

  const res = await router.evaluateRecall("Architectural decision with proactiveCapture off");
  assert.equal(res.recallRecommended, false);
  assert.equal(res.captureRecommended, false);
  assert.equal(res.captureCategory, null);
  assert.equal(res.reason, "laya_below_threshold");

  // Fast-path explicit pitfall directive must also respect proactiveCapture: false
  const fastPitfall = await router.evaluateRecall("踩坑教训：macOS 下不能通过 PID 强杀");
  assert.equal(fastPitfall.recallRecommended, false);
  assert.equal(fastPitfall.captureRecommended, false);
  assert.equal(fastPitfall.captureCategory, null);
  assert.equal(fastPitfall.reason, "proactive_capture_disabled");

  router.dispose();
});

test("MemoryRouter prioritizes recallRecommended over captureRecommended", async () => {
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          service: "laya-memory-judge",
          status: "ok",
          api_version: "1",
          model_status: "ready",
          capabilities: ["recall"]
        })
      };
    }
    if (u.endsWith("/judge/recall")) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          requires_memory: 0.88,
          confidence: 0.95,
          scope: { project: 0.90 },
          categories: { pitfall: 0.01, decision: 0.96, knowledge: 0.03 }
        })
      };
    }
    throw new Error("Unexpected request: " + u);
  };

  const router = new MemoryRouter({
    mode: "manual",
    endpoint: "http://127.0.0.1:18791",
    recallThreshold: 0.70,
    captureThreshold: 0.75,
    proactiveCapture: true
  }, { fetch: mockFetch });

  const res = await router.evaluateRecall("User asking about previous architectural decision");
  assert.equal(res.recallRecommended, true);
  assert.equal(res.captureRecommended, false);
  assert.equal(res.reason, "laya_threshold_met");

  router.dispose();
});
