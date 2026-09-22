import { DEFAULT_MEMORY_JUDGE, parseMemoryJudgeConfig } from "../config.js";
import { readTrustedServiceFile } from "./security.js";
import { evaluateFastPath } from "./fast-path.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { LayaClient, LayaHttpError } from "./client.js";
import { readStateCache, writeStateCache, getEndpointCache } from "./cache.js";

export class MemoryRouter {
  constructor(config = DEFAULT_MEMORY_JUDGE, options = {}) {
    this.config = parseMemoryJudgeConfig(config);
    this.options = options;
    this.logger = options.logger ?? null;
    this.clock = options.clock ?? (() => Date.now());
    this.timers = {
      setTimeout: options.timers?.setTimeout ?? globalThis.setTimeout,
      clearTimeout: options.timers?.clearTimeout ?? globalThis.clearTimeout,
      setInterval: options.timers?.setInterval ?? globalThis.setInterval,
      clearInterval: options.timers?.clearInterval ?? globalThis.clearInterval
    };

    this.cachePath = options.cachePath ?? null;
    // Default to false so long-running hosts (OpenClaw) do not contaminate CLI cache
    this.useCache = options.useCache ?? false;

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: this.config.consecutiveFailures,
      resetTimeoutMs: this.config.resetTimeout,
      clock: this.clock
    });

    this.client = null;
    this.endpoint = this.config.endpoint || null;
    this.instanceId = null;
    this.pid = null;
    this.healthChecked = false;
    this.healthInfo = null;
    this.modelStatus = "unknown";
    this.lastDiscoveryTime = 0;
    this.discoveryTimer = null;
    this.identityGeneration = 1;
    this._healthHandshakePromise = null;
    this._healthHandshakePromiseGen = 0;

    this._initializeClient();
  }

  _bumpIdentityGeneration() {
    this.identityGeneration = (this.identityGeneration + 1) | 0;
    this._healthHandshakePromise = null;
    this._healthHandshakePromiseGen = 0;
  }

  _loadPersistedEndpointState(endpoint) {
    if (!this.useCache || !endpoint) return;

    const cached = readStateCache(this.cachePath, {
      fs: this.options.fs,
      clock: this.clock,
      platform: this.options.platform,
      env: this.options.env,
      homedir: this.options.homedir
    });

    if (cached) {
      const endpointCache = getEndpointCache(cached, endpoint, {
        resetTimeoutMs: this.config.resetTimeout,
        now: this.clock()
      });

      if (endpointCache?.circuitBreaker) {
        this.circuitBreaker.hydrate(endpointCache.circuitBreaker);
      }

      if (endpointCache?.health && (endpointCache.health.status === "ok" || endpointCache.health.status === "degraded")) {
        this.healthChecked = true;
        this.healthInfo = endpointCache.health;
        this.modelStatus = endpointCache.health.modelStatus || "ready";
      }
    }
  }

  _savePersistedState() {
    if (!this.useCache || !this.client?.endpoint) return;

    const breakerSnapshot = this.circuitBreaker.snapshot();
    const healthToSave = (this.healthChecked && this.healthInfo) ? {
      status: this.healthInfo.status,
      modelStatus: this.modelStatus,
      checkedAt: this.healthInfo.checkedAt || this.clock()
    } : null;

    writeStateCache(this.cachePath, {
      circuitBreaker: breakerSnapshot,
      health: healthToSave,
      lastDiscovery: {
        endpoint: this.client.endpoint,
        checkedAt: this.lastDiscoveryTime || this.clock()
      }
    }, {
      endpoint: this.client.endpoint,
      fs: this.options.fs,
      clock: this.clock,
      platform: this.options.platform,
      env: this.options.env,
      homedir: this.options.homedir
    });
  }

  _initializeClient() {
    if (this.config.mode === "off") {
      this.client = null;
      return;
    }

    if (this.config.mode === "manual") {
      if (this.config.endpoint) {
        this._bumpIdentityGeneration();
        this.client = new LayaClient(this.config.endpoint, {
          fetch: this.options.fetch,
          AbortController: this.options.AbortController,
          timers: this.timers,
          logger: this.logger
        });
        this._loadPersistedEndpointState(this.config.endpoint);
      }
      return;
    }

    if (this.config.mode === "auto") {
      const discovered = this._discoverAutoEndpoint();
      if (discovered && this.client?.endpoint) {
        this._loadPersistedEndpointState(this.client.endpoint);
      }
      if (typeof this.timers.setInterval === "function" && (!this.client || !this.healthChecked)) {
        this._startDiscoveryTimer();
      }
    }
  }

  _startDiscoveryTimer() {
    if (this.discoveryTimer) return;
    const interval = this.config.discoveryInterval;
    this.discoveryTimer = this.timers.setInterval(async () => {
      // 1. Purely local trusted file discovery: inspect local service.json (0 network)
      const found = this._discoverAutoEndpoint();
      if (!found || !this.client) {
        // No valid service file or client found; do NOT claim any circuit breaker probe slot
        return;
      }

      // 2. If the current service identity is already health-verified (healthChecked === true),
      // the background timer ONLY monitors local service.json for identity changes.
      // It must NOT consume circuit breaker probes or attempt business recovery probes!
      if (this.healthChecked) {
        return;
      }

      // 3. Current identity needs initial health handshake: respect circuit breaker cooldown!
      // Only proceed if breaker is CLOSED or transitions OPEN -> HALF_OPEN with the single probe slot.
      if (!this.circuitBreaker.canAttempt()) {
        return;
      }

      // 4. Send initial health network probe for unverified identity
      const healthy = await this._ensureHealthHandshake({ fromTimer: true });
      if (healthy) {
        this._stopDiscoveryTimer();
      }
    }, interval);

    if (typeof this.discoveryTimer?.unref === "function") {
      this.discoveryTimer.unref();
    }
  }

  _stopDiscoveryTimer() {
    if (this.discoveryTimer) {
      this.timers.clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  _discoverAutoEndpoint() {
    this.lastDiscoveryTime = this.clock();
    const serviceInfo = readTrustedServiceFile(this.config.serviceFile, {
      fs: this.options.fs,
      platform: this.options.platform,
      getuid: this.options.getuid,
      homedir: this.options.homedir
    });

    if (serviceInfo?.endpoint) {
      const oldEndpoint = this.endpoint;
      const newEndpoint = serviceInfo.endpoint;
      const oldToken = this.client?.token;
      const newToken = serviceInfo.token;
      const oldInstanceId = this.instanceId;
      const newInstanceId = serviceInfo.instance_id ?? null;
      const oldPid = this.pid;
      const newPid = serviceInfo.pid ?? null;

      const identityChanged = (
        oldEndpoint !== newEndpoint ||
        oldToken !== newToken ||
        (newInstanceId !== null && oldInstanceId !== null && oldInstanceId !== newInstanceId) ||
        (newPid !== null && oldPid !== null && oldPid !== newPid)
      );

      if (identityChanged) {
        this._bumpIdentityGeneration();
        this.endpoint = newEndpoint;
        this.instanceId = newInstanceId;
        this.pid = newPid;
        // Endpoint, token, instance_id, or pid changed: reset health & breaker to avoid cross-endpoint/identity state pollution
        this.healthChecked = false;
        this.healthInfo = null;
        this.modelStatus = "unknown";
        this.circuitBreaker.reset();

        this.client = new LayaClient(newEndpoint, {
          token: newToken,
          fetch: this.options.fetch,
          AbortController: this.options.AbortController,
          timers: this.timers,
          logger: this.logger
        });

        // Hydrate the new endpoint's state from cache (if any)
        if (oldEndpoint !== newEndpoint) {
          this._loadPersistedEndpointState(newEndpoint);
        }
      } else if (!this.client) {
        this._bumpIdentityGeneration();
        this.endpoint = newEndpoint;
        this.instanceId = newInstanceId;
        this.pid = newPid;
        this.client = new LayaClient(newEndpoint, {
          token: newToken,
          fetch: this.options.fetch,
          AbortController: this.options.AbortController,
          timers: this.timers,
          logger: this.logger
        });
        this.healthChecked = false;
        this.healthInfo = null;
      } else {
        // Same identity: latch instanceId and pid if newly discovered
        if (newInstanceId && !this.instanceId) this.instanceId = newInstanceId;
        if (newPid && !this.pid) this.pid = newPid;
      }
      return true;
    }

    if (this.client) {
      this._bumpIdentityGeneration();
      this.client = null;
      this.instanceId = null;
      this.pid = null;
      this.healthChecked = false;
      this.healthInfo = null;
      this.modelStatus = "unknown";
      // Breaker state is preserved for this.endpoint while service is absent
    }
    return false;
  }

  async _ensureHealthHandshake({ fromTimer = false } = {}) {
    if (!this.client || this.healthChecked) {
      return this.healthChecked;
    }
    if (this._healthHandshakePromise && this._healthHandshakePromiseGen === this.identityGeneration) {
      return this._healthHandshakePromise;
    }

    const currentGen = this.identityGeneration;
    const client = this.client;
    const currentEndpoint = client.endpoint;
    const currentToken = client.token;

    this._healthHandshakePromiseGen = currentGen;
    this._healthHandshakePromise = (async () => {
      try {
        const health = await client.healthCheck({ timeout: this.config.healthTimeout });
        if (
          this.identityGeneration !== currentGen ||
          this.client !== client ||
          this.endpoint !== currentEndpoint ||
          this.client?.token !== currentToken
        ) {
          // Stale handshake from previous identity: discard result without modifying state
          return false;
        }

        const healthInstance = health.instanceId ?? health.instance_id;
        if (this.instanceId && healthInstance && healthInstance !== this.instanceId) {
          // Stale handshake from mismatched instance: discard result without modifying state
          return false;
        }
        if (healthInstance && !this.instanceId) {
          this.instanceId = healthInstance;
        }

        this.healthChecked = true;
        this.healthInfo = health;
        this.modelStatus = health.modelStatus || "ready";
        // Only close circuit breaker on standalone timer probes!
        // In business evaluateRecall turns, do not call recordSuccess() here because the turn is only successful if judgeRecall succeeds.
        if (fromTimer) {
          this.circuitBreaker.recordSuccess();
        }
        this._savePersistedState();
        return true;
      } catch (err) {
        if (
          this.identityGeneration !== currentGen ||
          this.client !== client ||
          this.endpoint !== currentEndpoint ||
          this.client?.token !== currentToken
        ) {
          // Stale handshake from previous identity: discard error without modifying state
          return false;
        }

        const permanent = err instanceof LayaHttpError ? err.permanent : false;
        const isAuth = err instanceof LayaHttpError ? err.auth : false;
        this.circuitBreaker.recordFailure({ permanent });
        this.healthChecked = false;
        this.healthInfo = null;
        this._savePersistedState();
        if (isAuth) {
          this.logger?.warn?.("[Laya Memory Judge] Authentication failed for local service");
        } else {
          this.logger?.debug?.(`[Laya Memory Judge] Health handshake failed: ${err.message}`);
        }
        return false;
      } finally {
        if (this._healthHandshakePromiseGen === currentGen) {
          this._healthHandshakePromise = null;
          this._healthHandshakePromiseGen = 0;
        }
      }
    })();

    return this._healthHandshakePromise;
  }

  async evaluateRecall(text, projectContext = null) {
    // 1. Mode OFF -> Absolute zero network, zero delay
    if (this.config.mode === "off") {
      return { recallRecommended: false, reason: "mode_off" };
    }

    // 2. Deterministic Fast-Path Filter
    const fast = evaluateFastPath(text);
    if (fast.action !== "consult_laya") {
      return {
        recallRecommended: fast.recallRecommended,
        score: fast.score ?? null,
        reason: fast.reason
      };
    }

    // 3. Resolve Client if Auto Mode and currently unattached
    if (!this.client && this.config.mode === "auto") {
      // If discovery timer is already running, wait for timer interval!
      if (this.discoveryTimer) {
        return { recallRecommended: false, reason: "no_trusted_service" };
      }

      this._discoverAutoEndpoint();
      if (this.client?.endpoint) {
        this._loadPersistedEndpointState(this.client.endpoint);
      } else {
        this._startDiscoveryTimer();
        return { recallRecommended: false, reason: "no_trusted_service" };
      }
    }

    if (!this.client) {
      return { recallRecommended: false, reason: "unconfigured_endpoint" };
    }

    // 4. Circuit Breaker Check
    if (!this.circuitBreaker.canAttempt()) {
      return { recallRecommended: false, reason: "circuit_breaker_open" };
    }

    const callGen = this.identityGeneration;
    const callClient = this.client;
    const callEndpoint = this.endpoint;
    const callToken = this.client?.token;

    // 5. Initial Health Handshake Verification before business query
    if (!this.healthChecked) {
      const healthy = await this._ensureHealthHandshake({ fromTimer: false });
      if (
        !healthy ||
        this.identityGeneration !== callGen ||
        this.client !== callClient ||
        this.endpoint !== callEndpoint ||
        this.client?.token !== callToken ||
        !this.healthChecked
      ) {
        return { recallRecommended: false, reason: "health_handshake_failed" };
      }
    }

    // Double check identity before calling judgeRecall
    if (
      this.identityGeneration !== callGen ||
      this.client !== callClient ||
      this.endpoint !== callEndpoint ||
      this.client?.token !== callToken ||
      !this.healthChecked ||
      !callClient
    ) {
      return { recallRecommended: false, reason: "health_handshake_failed" };
    }

    // 6. Determine timeout (cold start vs warm)
    // Both "unloaded" and "loading" qualify as cold start
    const isCold = this.modelStatus === "unloaded" || this.modelStatus === "loading";
    const timeout = isCold ? this.config.coldStartTimeout : this.config.timeout;

    // 7. Execute Recall Judge
    try {
      const result = await callClient.judgeRecall({
        text,
        projectContext,
        timeout
      });

      if (
        this.identityGeneration !== callGen ||
        this.client !== callClient ||
        this.endpoint !== callEndpoint ||
        this.client?.token !== callToken
      ) {
        return { recallRecommended: false, reason: "laya_fallback" };
      }

      // Overall business query succeeded! Now close breaker or maintain CLOSED state.
      this.circuitBreaker.recordSuccess();
      this.modelStatus = "ready";
      this._stopDiscoveryTimer(); // Business call succeeded; stop discovery timer since service is healthy
      this._savePersistedState();

      const recallRecommended = result.requiresMemory >= this.config.recallThreshold;
      return {
        recallRecommended,
        score: result.requiresMemory,
        confidence: result.confidence,
        scope: result.bestScope, // Guaranteed enum "project" or "global"
        categories: result.categories,
        reason: recallRecommended ? "laya_threshold_met" : "laya_below_threshold"
      };
    } catch (err) {
      if (
        this.identityGeneration !== callGen ||
        this.client !== callClient ||
        this.endpoint !== callEndpoint ||
        this.client?.token !== callToken
      ) {
        return { recallRecommended: false, reason: "laya_fallback" };
      }

      const permanent = err instanceof LayaHttpError ? err.permanent : false;
      const isAuth = err instanceof LayaHttpError ? err.auth : false;
      this.circuitBreaker.recordFailure({ permanent });
      this._savePersistedState();
      if (this.config.mode === "auto" && typeof this.timers.setInterval === "function") {
        this._startDiscoveryTimer();
      }
      if (isAuth) {
        this.logger?.warn?.("[Laya Memory Judge] Authentication failed for local service");
      } else {
        this.logger?.debug?.(`[Laya Memory Judge] Request failed: ${err.message}`);
      }
      return {
        recallRecommended: false,
        reason: "laya_fallback",
        error: err.message
      };
    }
  }

  dispose() {
    this._bumpIdentityGeneration();
    this._stopDiscoveryTimer();
    this.circuitBreaker.reset();
    this.client = null;
    this.healthChecked = false;
    this.healthInfo = null;
    this._healthHandshakePromise = null;
  }
}

export function createMemoryRouter(config, options) {
  return new MemoryRouter(config, options);
}
