import { DEFAULT_MEMORY_JUDGE, parseMemoryJudgeConfig } from "../config.js";
import { readTrustedServiceFile } from "./security.js";
import { evaluateFastPath } from "./fast-path.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { LayaClient, LayaHttpError } from "./client.js";
import { readStateCache, writeStateCache, getEndpointCache } from "./cache.js";
import { memoryActionFor } from "../prompt.js";
import { isPidRunning, requestServiceAutoRestart, serviceWasPreviouslyHealthy } from "./auto-restart.js";

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
    this.modelIdleUnloadSeconds = 0;
    this.lastInferenceAt = 0;
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

  _markModelColdIfIdle() {
    if (
      this.modelStatus === "ready" &&
      this.modelIdleUnloadSeconds > 0 &&
      this.lastInferenceAt > 0 &&
      this.clock() - this.lastInferenceAt >= this.modelIdleUnloadSeconds * 1000
    ) {
      this.modelStatus = "unloaded";
    }
  }

  _hasPersistedHealthyService() {
    if (!this.useCache) return false;
    const cached = readStateCache(this.cachePath, {
      fs: this.options.fs,
      clock: this.clock,
      platform: this.options.platform,
      env: this.options.env,
      homedir: this.options.homedir
    });
    return serviceWasPreviouslyHealthy(cached, this.clock());
  }

  _scheduleAutoRestart({ knownHealthy = this.healthChecked, deadPid = false } = {}) {
    if (this.config.mode !== "auto" || (!knownHealthy && !deadPid)) return false;
    const restart = this.options.requestServiceAutoRestart ?? requestServiceAutoRestart;
    try {
      const result = restart(this.config.serviceFile, {
        fs: this.options.fs,
        platform: this.options.platform,
        env: this.options.env,
        processApi: this.options.processApi,
        spawn: this.options.spawnServiceRecovery
      });
      return Boolean(result?.scheduled);
    } catch {
      return false;
    }
  }

  _knownServiceProcessIsDead() {
    if (!Number.isInteger(this.pid) || this.pid <= 0) return false;
    const check = this.options.isPidRunning;
    return !(typeof check === "function" ? check(this.pid) : isPidRunning(this.pid, this.options.processApi));
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
        this.modelIdleUnloadSeconds = endpointCache.health.idleUnloadSeconds || 0;
        this.lastInferenceAt = endpointCache.health.lastInferenceAt || 0;
        this._markModelColdIfIdle();
      }
    }
  }

  _savePersistedState() {
    if (!this.useCache || !this.client?.endpoint) return;

    const breakerSnapshot = this.circuitBreaker.snapshot();
    const healthToSave = (this.healthChecked && this.healthInfo) ? {
      status: this.healthInfo.status,
      modelStatus: this.modelStatus,
      checkedAt: this.healthInfo.checkedAt || this.clock(),
      idleUnloadSeconds: this.modelIdleUnloadSeconds,
      lastInferenceAt: this.lastInferenceAt
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

    if (this.config.mode === "auto" || this.config.mode === "strict") {
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
        this.modelIdleUnloadSeconds = 0;
        this.lastInferenceAt = 0;
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
      this.modelIdleUnloadSeconds = 0;
      this.lastInferenceAt = 0;
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
        this.modelIdleUnloadSeconds = health.idleUnloadSeconds ?? this.modelIdleUnloadSeconds;
        this._markModelColdIfIdle();
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
    const result = await this._evaluateRecall(text, projectContext);
    result.memoryAction = memoryActionFor(result, this.config.skipThreshold);
    return result;
  }

  async _evaluateRecall(text, projectContext = null) {
    const isStrict = this.config.mode === "strict";

    // hookExecuted stays false here: only real host hook adapters may set it to true.
    const makeTrace = (route, decision, reason, layaAttempted) => ({
      route, // "laya" | "fast_path" | "fallback"
      decision, // "recall" | "capture" | "none"
      reason,
      hookExecuted: false,
      layaAttempted
    });

    // Laya could not give a verdict: strict mode blocks (fail-closed), other modes fail open.
    const unavailable = (strictReason, reason, layaAttempted, extra = {}) => {
      const blocked = isStrict;
      const finalReason = blocked ? strictReason : reason;
      return {
        recallRecommended: false,
        captureRecommended: false,
        captureCategory: null,
        blocked,
        reason: finalReason,
        ...extra,
        trace: makeTrace("fallback", "none", finalReason, layaAttempted)
      };
    };

    // 1. Mode OFF -> Absolute zero network, zero delay
    if (this.config.mode === "off") {
      return {
        recallRecommended: false,
        captureRecommended: false,
        captureCategory: null,
        score: null,
        scope: null,
        reason: "mode_off",
        blocked: false,
        trace: makeTrace("fallback", "none", "mode_off", false)
      };
    }

    // 2. Deterministic Fast-Path Filter
    const fast = evaluateFastPath(text);
    if (fast.action !== "consult_laya") {
      const isCaptureDisabled = this.config.proactiveCapture === false;
      const captureRecommended = isCaptureDisabled ? false : (fast.captureRecommended ?? false);
      const captureCategory = captureRecommended ? (fast.captureCategory ?? null) : null;
      const recallRecommended = fast.recallRecommended ?? false;
      const reason = (isCaptureDisabled && fast.captureRecommended) ? "proactive_capture_disabled" : fast.reason;
      const decision = recallRecommended ? "recall" : (captureRecommended ? "capture" : "none");
      return {
        recallRecommended,
        captureRecommended,
        captureCategory,
        score: fast.score ?? null,
        scope: (recallRecommended || captureRecommended) ? (fast.scope ?? "project") : null,
        reason,
        blocked: false,
        trace: makeTrace("fast_path", decision, reason, false)
      };
    }

    // 3. Resolve Client if Auto or Strict Mode and currently unattached
    if (!this.client && (this.config.mode === "auto" || isStrict)) {
      const persistedHealthy = this._hasPersistedHealthyService();
      if (this.discoveryTimer) {
        const restartScheduled = this._scheduleAutoRestart({ knownHealthy: persistedHealthy });
        return unavailable("strict_mode_laya_unavailable", restartScheduled ? "service_restart_scheduled" : "no_trusted_service", false);
      }

      this._discoverAutoEndpoint();
      if (this.client?.endpoint) {
        this._loadPersistedEndpointState(this.client.endpoint);
      } else {
        const restartScheduled = this._scheduleAutoRestart({ knownHealthy: persistedHealthy });
        this._startDiscoveryTimer();
        return unavailable("strict_mode_laya_unavailable", restartScheduled ? "service_restart_scheduled" : "no_trusted_service", false);
      }
    }

    if (this._knownServiceProcessIsDead()) {
      const restartScheduled = this._scheduleAutoRestart({ deadPid: true });
      return unavailable("strict_mode_laya_unavailable", restartScheduled ? "service_restart_scheduled" : "service_process_dead", false);
    }

    if (!this.client) {
      return unavailable("strict_mode_laya_unavailable", "unconfigured_endpoint", false);
    }

    // 4. Circuit Breaker Check
    if (!this.circuitBreaker.canAttempt()) {
      return unavailable("strict_mode_circuit_breaker_open", "circuit_breaker_open", false);
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
        return unavailable("strict_mode_health_handshake_failed", "health_handshake_failed", true);
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
      return unavailable("strict_mode_health_handshake_failed", "health_handshake_failed", true);
    }

    // A long-lived host can retain stale "ready" state after the daemon unloads the model.
    // Mark it cold locally so the next request gets the configured cold-start timeout.
    this._markModelColdIfIdle();

    // 6. Determine timeout (cold start vs warm)
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
        return unavailable("strict_mode_identity_conflict", "laya_fallback", true);
      }

      this.circuitBreaker.recordSuccess();
      this.modelStatus = "ready";
      this.lastInferenceAt = this.clock();
      this._stopDiscoveryTimer();
      this._savePersistedState();

      const recallRecommended = result.requiresMemory >= this.config.recallThreshold;

      let captureRecommended = false;
      let captureCategory = null;

      if (this.config.proactiveCapture) {
        const threshold = this.config.captureThreshold ?? 0.75;
        const catConfidence = result.categoryConfidence ?? result.confidence ?? 0.0;
        const pitfallScore = result.categories?.pitfall ?? 0.0;
        const decisionScore = result.categories?.decision ?? 0.0;

        if (!recallRecommended && catConfidence >= 0.70) {
          if (pitfallScore >= threshold && pitfallScore >= decisionScore) {
            captureRecommended = true;
            captureCategory = "pitfall";
          } else if (decisionScore >= threshold) {
            captureRecommended = true;
            captureCategory = "decision";
          }
        }
      }

      let reason = "laya_below_threshold";
      if (recallRecommended) {
        reason = "laya_threshold_met";
      } else if (captureRecommended) {
        reason = "laya_capture_recommended";
      }

      const decision = recallRecommended ? "recall" : (captureRecommended ? "capture" : "none");

      return {
        recallRecommended,
        captureRecommended,
        captureCategory,
        score: result.requiresMemory,
        confidence: result.confidence,
        scope: result.bestScope,
        categories: result.categories,
        reason,
        blocked: false,
        trace: makeTrace("laya", decision, reason, true)
      };
    } catch (err) {
      if (
        this.identityGeneration !== callGen ||
        this.client !== callClient ||
        this.endpoint !== callEndpoint ||
        this.client?.token !== callToken
      ) {
        return unavailable("strict_mode_identity_conflict", "laya_fallback", true);
      }

      const permanent = err instanceof LayaHttpError ? err.permanent : false;
      const isAuth = err instanceof LayaHttpError ? err.auth : false;
      this.circuitBreaker.recordFailure({ permanent });
      const restartScheduled = this._knownServiceProcessIsDead() && this._scheduleAutoRestart({ deadPid: true });
      this._savePersistedState();
      if ((this.config.mode === "auto" || isStrict) && typeof this.timers.setInterval === "function") {
        this._startDiscoveryTimer();
      }
      if (isAuth) {
        this.logger?.warn?.("[Laya Memory Judge] Authentication failed for local service");
      } else {
        this.logger?.debug?.(`[Laya Memory Judge] Request failed: ${err.message}`);
      }

      return unavailable("strict_mode_laya_error", restartScheduled ? "service_restart_scheduled" : "laya_fallback", true, { error: err.message });
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
