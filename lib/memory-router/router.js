import { DEFAULT_MEMORY_JUDGE, parseMemoryJudgeConfig } from "../config.js";
import { readTrustedServiceFile } from "./security.js";
import { evaluateFastPath, isGenericQuestion, stripHostContext } from "./fast-path.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { LayaClient, LayaHttpError } from "./client.js";
import { readStateCache, writeStateCache, getEndpointCache } from "./cache.js";
import { memoryActionFor } from "../prompt.js";
import { enrichDecision } from "./turn-context.js";
import { loadVaultIndex, loadEmbeddingCache, pendingEmbeddings, ensureVaultEmbeddings, defaultIndexCachePath, defaultEmbeddingCachePath } from "./vault-index.js";
import { stateFile } from "./paths.js";
import fs from "node:fs";
import path from "node:path";

const EMBED_BACKFILL_BUDGET_MS = 2000;
const EMBED_BACKFILL_PAUSE_MS = 10 * 60 * 1000;

// A statement is queued for the session digest (never hinted) at this durable-statement score; the
// user reviews every digest candidate, so the bar is lower than the 0.75 used for an in-turn hint.
const DIGEST_DURABLE_THRESHOLD = 0.5;
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
    // When this process last saw a live /health answer (0 = only the persisted cache so far).
    this._healthAt = 0;

    this._initializeClient();
  }

  _bumpIdentityGeneration() {
    this.identityGeneration = (this.identityGeneration + 1) | 0;
    this._healthAt = 0;
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

  async _warmIfCold() {
    if (this.config.coldStart !== "background" || !this.client || !this.healthChecked) return;
    this._markModelColdIfIdle();
    if (this.modelStatus !== "unloaded") return;
    try {
      const status = await this.client.warmup({ timeout: Math.max(this.config.healthTimeout, 300) });
      this.modelStatus = status.modelStatus === "ready" ? "ready" : "loading";
      this._savePersistedState();
    } catch {
      // Older services without /warmup, or a busy service: the next Laya turn handles the cold start.
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
      lastInferenceAt: this.lastInferenceAt,
      ...(Array.isArray(this.healthInfo.capabilities) ? { capabilities: this.healthInfo.capabilities } : {})
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
        this._healthAt = this.clock();
        this.modelStatus = health.modelStatus || "ready";
        this.modelIdleUnloadSeconds = health.idleUnloadSeconds ?? this.modelIdleUnloadSeconds;
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

  /**
   * turn (optional, from host adapters): { host, sessionKey, vaultPath, cwd, projectId }.
   * Without it there are no side effects beyond the Laya call (no Vault reads, no logs).
   */
  async evaluateRecall(text, projectContext = null, turn = null) {
    // Judge, log and queue only the user's own words. A message that is nothing but host context is kept as
    // is, so the fast path reports it as a system message.
    text = (typeof text === "string" && stripHostContext(text)) || text;
    const result = await this._evaluateRecall(text, projectContext);
    result.memoryAction = memoryActionFor(result, this.config.skipThreshold);
    // mode "off" behaves as if the router did not exist: no Vault index, session state, decision log,
    // capture queue or digest, and no file under ~/.laya. The always-on rule and the skill still work.
    if (this.config.mode === "off") return result;
    if (turn && typeof turn === "object") {
      let vaultIndex = null;
      let embeddingCache = null;
      const semanticOn = turn.vaultPath && this.config.vaultHints !== false && this.config.vaultSemantic !== false;
      // An explicit "do you remember ..." is decided by the fast path without the model, so it has no prompt
      // vector; fetch one (one short retriever call, only on these turns) so the notes it names are found by
      // meaning, not just shared words.
      if (semanticOn && !result.queryEmbedding && result.trace?.route === "fast_path" && result.recallRecommended) {
        try {
          const out = await this.embedTexts([text], "query", { timeout: 1500 });
          if (out?.vectors?.[0]) { result.queryEmbedding = out.vectors[0]; result.embedModel = out.model; }
        } catch {}
      }
      try {
        if (semanticOn && result.queryEmbedding) {
          ({ index: vaultIndex, cache: embeddingCache } = await this._prepareVaultEmbeddings(turn.vaultPath, result.embedModel));
        }
      } catch {
        // No retriever this turn: the word-overlap hints still run.
      }
      try {
        enrichDecision(result, text, {
          ...turn,
          projectId: turn.projectId ?? (typeof projectContext?.project_id === "string" ? projectContext.project_id : null)
        }, this.config, {
          now: this.clock(),
          env: this.options.env,
          indexCachePath: this.options.vaultIndexCachePath,
          sessionStatePath: this.options.sessionStatePath,
          decisionLogPath: this.options.decisionLogPath,
          vaultIndex,
          embeddingCache
        });
      } catch {
        // Best-effort context; the Laya decision stands.
      }
    }
    // The prompt's vector is routing data only: never hand it to hosts, logs or prompts.
    delete result.queryEmbedding;
    return result;
  }

  /**
   * Laya's capture score for a completed-work text (the agent's final reply), or null when the service is
   * not usable right now. Bounded and silent: the end-of-turn check works without it.
   */
  // A usable client for calls outside the per-turn judgement (capture score, embeddings), or null.
  async _sideCallClient() {
    if (this.config.mode === "off") return null;
    if (!this.client && (this.config.mode === "auto" || this.config.mode === "strict")) this._discoverAutoEndpoint();
    if (!this.client || !this.circuitBreaker.canAttempt()) return null;
    if (!this.healthChecked && !(await this._ensureHealthHandshake({ fromTimer: false }))) return null;
    return this.client;
  }

  /** Unit vectors from the service's retriever: { model, vectors }, or null. Batches of 32. */
  async embedTexts(texts, kind = "query", { timeout = 8000 } = {}) {
    try {
      const client = await this._sideCallClient();
      if (!client || !this._supportsEmbed() || !Array.isArray(texts) || texts.length === 0) return null;
      const vectors = [];
      let model = null;
      for (let i = 0; i < texts.length; i += 32) {
        const out = await client.embed({ texts: texts.slice(i, i + 32).map((t) => String(t).slice(0, 1200) || " "), kind, timeout });
        model = out.model;
        vectors.push(...out.vectors);
      }
      return { model, vectors };
    } catch {
      return null;
    }
  }

  /**
   * For background work (the session digest), not a user's turn: make sure the model is loaded, waiting
   * up to `waitMs` for an idle-unloaded model. Returns true when it is ready. Never throws.
   */
  async ensureModelReady({ waitMs = 45000, pollMs = 1500 } = {}) {
    try {
      const client = await this._sideCallClient();
      if (!client) return false;
      try {
        const status = await client.warmup({ timeout: 2000 });
        this.modelStatus = status.modelStatus === "ready" ? "ready" : "loading";
      } catch {}
      const deadline = this.clock() + waitMs;
      while (this.modelStatus !== "ready" && this.clock() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        try {
          const health = await client.healthCheck({ timeout: 2000 });
          this.modelStatus = health.modelStatus || this.modelStatus;
        } catch {}
      }
      return this.modelStatus === "ready";
    } catch {
      return false;
    }
  }

  async captureScoreFor(text, { timeout = 2500 } = {}) {
    try {
      if (!(await this._sideCallClient())) return null;
      if (this.modelStatus === "unloaded" || this.modelStatus === "loading") return null;
      const clean = String(text).replace(/\s+/gu, " ").trim().slice(0, 1500);
      if (clean.length < 40) return null;
      const out = await this.client.judgeCapture({ text: clean, timeout });
      return typeof out?.captureScore === "number" ? out.captureScore : null;
    } catch {
      return null;
    }
  }

  // Ask for the prompt vector unless the service is known not to embed. Unknown capabilities (a health
  // state restored from an older cache) still ask: a service without a retriever ignores the field.
  _supportsEmbed() {
    const caps = this.healthInfo?.capabilities;
    return !Array.isArray(caps) || caps.includes("embed");
  }

  /**
   * Index the Vault's notes and keep their vectors (from the service's retriever) cached. One batch
   * of new or changed notes per turn keeps a hook within its budget; a Vault is fully covered after
   * a few turns and stays current as notes change. Failures leave the cache as it was.
   */
  async _prepareVaultEmbeddings(vaultPath, model) {
    const index = loadVaultIndex(vaultPath, { cachePath: this.options.vaultIndexCachePath ?? defaultIndexCachePath(), now: this.clock() });
    if (!index || !model) return { index, cache: null };
    const cachePath = this.options.embeddingCachePath ?? defaultEmbeddingCachePath();
    const cache = loadEmbeddingCache(cachePath, { vaultPath, model });
    const client = this.client;
    // Backfill runs inside a user's turn, so it gets a small budget, never runs while the breaker is open,
    // and pauses for a while (across hook processes) after a failure: a slow retriever must not add seconds
    // to every turn. New notes are picked up on a later turn.
    const pausePath = this.options.embedBackfillStatePath ?? stateFile("embed-backfill.json");
    const pausedUntil = (() => { try { return JSON.parse(fs.readFileSync(pausePath, "utf8")).pausedUntil ?? 0; } catch { return 0; } })();
    if (client && this.circuitBreaker.canAttempt() && this.clock() >= pausedUntil && pendingEmbeddings(index, cache).length > 0) {
      try {
        await ensureVaultEmbeddings(index, cache, async (texts) => {
          const out = await client.embed({ texts, kind: "passage", timeout: Math.max(this.config.timeout * 2, EMBED_BACKFILL_BUDGET_MS) });
          if (out.model !== model) throw new Error("retriever model changed");
          return out.vectors;
        }, { cachePath, maxNotes: this.options.embedBatchSize ?? 32 });
      } catch (err) {
        this.logger?.debug?.(`[Laya Memory Router] Vault embedding paused: ${err.message}`);
        try {
          fs.mkdirSync(path.dirname(pausePath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(pausePath, JSON.stringify({ pausedUntil: this.clock() + EMBED_BACKFILL_PAUSE_MS, reason: String(err.message).slice(0, 120) }), { mode: 0o600 });
        } catch {}
      }
    }
    return { index, cache };
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
      // A save request that also points at earlier work ("记住，我们约定……") gets both hints; with capture
      // disabled it is just the recall.
      const alsoRecall = Boolean(fast.alsoRecall);
      const recallRecommended = (fast.recallRecommended ?? false) || (alsoRecall && isCaptureDisabled);
      const reason = (isCaptureDisabled && fast.captureRecommended) ? "proactive_capture_disabled" : fast.reason;
      const decision = recallRecommended ? "recall" : (captureRecommended ? "capture" : "none");
      const captureKind = captureRecommended ? "explicit" : null;
      // Fast-path turns do not need the model, but they are a sign of activity: start reloading an
      // idle-unloaded model now so the next ambiguous turn is judged instead of falling back.
      if (fast.reason !== "empty_text") await this._warmIfCold();
      return {
        recallRecommended,
        captureRecommended,
        captureCategory,
        captureKind,
        ...(alsoRecall && captureRecommended ? { alsoRecall: true } : {}),
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
    // A /health answer from a moment ago is more accurate than that prediction.
    const healthFresh = this._healthAt > 0 && this.clock() - this._healthAt < 5000;
    if (!healthFresh) this._markModelColdIfIdle();

    // 6. Determine timeout (cold start vs warm)
    let isCold = this.modelStatus === "unloaded" || this.modelStatus === "loading";

    // 6b. Background cold start: never make the user wait seconds for a model load. Confirm the
    // status with a fresh health check, ask the service to load in the background, and fall back
    // to the normal workflow for this turn only. Strict mode needs a verdict, so it keeps waiting.
    if (isCold && this.config.coldStart === "background" && !isStrict) {
      let supportsWarmup = Array.isArray(this.healthInfo?.capabilities) && this.healthInfo.capabilities.includes("warmup");
      if (!healthFresh) {
        try {
          const health = await callClient.healthCheck({ timeout: this.config.healthTimeout });
          if (this.identityGeneration === callGen && this.client === callClient) {
            this.healthInfo = health;
            this._healthAt = this.clock();
            this.modelStatus = health.modelStatus || this.modelStatus;
            supportsWarmup = Array.isArray(health.capabilities) && health.capabilities.includes("warmup");
          }
        } catch {
          // Keep the cached view; the judge call below will surface real failures.
        }
      }
      isCold = this.modelStatus === "unloaded" || this.modelStatus === "loading";
      if (isCold && supportsWarmup) {
        try {
          const status = await callClient.warmup({ timeout: Math.max(this.config.healthTimeout, 300) });
          if (this.identityGeneration === callGen && this.client === callClient) {
            this.modelStatus = status.modelStatus === "ready" ? "ready" : "loading";
          }
        } catch {
          this.modelStatus = "loading";
        }
        if (this.modelStatus !== "ready") {
          this._savePersistedState();
          return unavailable("strict_mode_laya_unavailable", "model_warming", true);
        }
        isCold = false;
      }
    }
    const timeout = isCold ? this.config.coldStartTimeout : this.config.timeout;

    // 7. Execute Recall Judge
    try {
      const result = await callClient.judgeRecall({
        text,
        projectContext,
        timeout,
        embed: this._supportsEmbed()
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

      // Laya often scores general knowledge questions ("X 和 Y 有什么区别") as needing history; the
      // wording says they do not, so they never get recall or capture from the model score alone.
      const generic = isGenericQuestion(text);
      const recallRecommended = !generic && result.requiresMemory >= this.config.recallThreshold;

      // Proactive capture. The old per-category capture answer fired 40 times on 735 real prompts and was
      // never right, so it is gone. What replaced it is a separate question, "does the user state something
      // that should still hold later?" (a rule, preference, decision, environment fact, lesson), scored by
      // a head trained on labelled real prompts. On the author's traffic it is right about 6 times in 10 at
      // the chosen threshold, so its hint is a *check*, not an order: the obsidian-memory skill's capture
      // tests still decide, and only an explicit user request ("记住……") is enforced at the end of the turn.
      const durable = typeof result.durableStatement === "number" && result.durableHead ? result.durableStatement : null;
      const durableStatement = !recallRecommended && !generic && this.config.proactiveCapture !== false &&
        this.config.autoCapture !== "off" && durable !== null && durable >= this.config.captureThreshold;
      // "digest": the statement goes to the capture queue (turn-context.js) instead of a hint that makes
      // the agent load the skill in the middle of its task. Queuing costs the agent nothing and the user
      // reviews every candidate, so it does not compete with a recall hint ("以后测试统一放 tests/" also
      // looks like a question about project conventions) and uses a lower bar than a hint does.
      const captureRecommended = durableStatement && this.config.autoCapture !== "digest";
      const durableCandidate = this.config.autoCapture === "digest" && !generic && this.config.proactiveCapture !== false &&
        durable !== null && durable >= Math.min(this.config.captureThreshold, DIGEST_DURABLE_THRESHOLD);
      const captureCategory = captureRecommended ? bestCategory(result.categories) : null;
      const captureKind = captureRecommended ? "durable" : null;

      let reason = generic && result.requiresMemory >= this.config.recallThreshold ? "generic_question" : "laya_below_threshold";
      if (recallRecommended) {
        reason = "laya_threshold_met";
      } else if (captureRecommended) {
        reason = "durable_statement";
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
        captureKind,
        ...(durable !== null ? { durableScore: durable } : {}),
        ...(durableCandidate ? { durableCandidate: true } : {}),
        reason,
        blocked: false,
        ...(result.queryEmbedding ? { queryEmbedding: result.queryEmbedding, embedModel: result.embedModel } : {}),
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

// Most likely note type for a durable statement; "decision" when the service gave no category answer.
function bestCategory(categories) {
  const entries = Object.entries(categories ?? {}).filter(([k, v]) => ["pitfall", "decision", "knowledge"].includes(k) && typeof v === "number");
  if (entries.length === 0) return "decision";
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0 ? entries[0][0] : "decision";
}

export function createMemoryRouter(config, options) {
  return new MemoryRouter(config, options);
}
