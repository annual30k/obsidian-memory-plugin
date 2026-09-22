export const MAX_BACKOFF_MS = 1_800_000; // 30 minutes
export const MAX_BACKOFF_MULTIPLIER = 6;

export const CircuitState = Object.freeze({
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN"
});

export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? 2;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 300000;
    this.clock = options.clock ?? (() => Date.now());

    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenProbeInFlight = false;
    this.permanentFailure = false;
    this.backoffMultiplier = 1;
  }

  getState() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      backoffMultiplier: this.backoffMultiplier,
      permanentFailure: this.permanentFailure,
      halfOpenProbeInFlight: this.halfOpenProbeInFlight
    };
  }

  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      backoffMultiplier: this.backoffMultiplier,
      permanentFailure: this.permanentFailure
    };
  }

  hydrate(data) {
    if (!data || typeof data !== "object") return false;
    const { state, consecutiveFailures, openedAt, backoffMultiplier, permanentFailure } = data;
    if (state !== CircuitState.CLOSED && state !== CircuitState.OPEN && state !== CircuitState.HALF_OPEN) {
      return false;
    }
    if (typeof consecutiveFailures !== "number" || consecutiveFailures < 0 || !Number.isInteger(consecutiveFailures)) {
      return false;
    }
    if (typeof openedAt !== "number" || openedAt < 0 || !Number.isFinite(openedAt)) {
      return false;
    }
    if (typeof backoffMultiplier !== "number" || backoffMultiplier < 1 || backoffMultiplier > MAX_BACKOFF_MULTIPLIER || !Number.isFinite(backoffMultiplier)) {
      return false;
    }
    this.state = state;
    this.consecutiveFailures = consecutiveFailures;
    this.openedAt = openedAt;
    this.backoffMultiplier = backoffMultiplier;
    this.permanentFailure = typeof permanentFailure === "boolean" ? permanentFailure : false;
    this.halfOpenProbeInFlight = false;
    return true;
  }

  canAttempt() {
    const now = this.clock();

    if (this.state === CircuitState.CLOSED) {
      return true;
    }

    if (this.state === CircuitState.OPEN) {
      if (this.permanentFailure) {
        return false;
      }
      const cooldown = Math.min(this.resetTimeoutMs * this.backoffMultiplier, MAX_BACKOFF_MS);
      if (now - this.openedAt >= cooldown) {
        // Cooldown expired, transition to HALF_OPEN and claim the single probe slot
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      // Exactly one probe allowed at a time in HALF_OPEN
      if (!this.halfOpenProbeInFlight) {
        this.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }

    return false;
  }

  recordSuccess() {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenProbeInFlight = false;
    this.permanentFailure = false;
    this.backoffMultiplier = 1;
  }

  recordFailure({ permanent = false } = {}) {
    const now = this.clock();
    this.halfOpenProbeInFlight = false;

    if (permanent) {
      this.state = CircuitState.OPEN;
      this.permanentFailure = true;
      this.openedAt = now;
      return;
    }

    if (this.state === CircuitState.HALF_OPEN) {
      // Probe failed in HALF_OPEN: immediately re-open with backoff
      this.state = CircuitState.OPEN;
      this.openedAt = now;
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.openedAt = now;
      }
    }
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenProbeInFlight = false;
    this.permanentFailure = false;
    this.backoffMultiplier = 1;
  }
}
