import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, CircuitState } from "../lib/memory-router/circuit-breaker.js";

test("CircuitBreaker transitions CLOSED -> OPEN on consecutive failures", () => {
  let currentTime = 1000;
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 10000,
    clock: () => currentTime
  });

  assert.equal(breaker.getState().state, CircuitState.CLOSED);
  assert.equal(breaker.canAttempt(), true);

  // Failure 1
  breaker.recordFailure();
  assert.equal(breaker.getState().state, CircuitState.CLOSED);
  assert.equal(breaker.getState().consecutiveFailures, 1);
  assert.equal(breaker.canAttempt(), true);

  // Failure 2 -> Threshold reached -> OPEN
  breaker.recordFailure();
  assert.equal(breaker.getState().state, CircuitState.OPEN);
  assert.equal(breaker.canAttempt(), false);
});

test("CircuitBreaker immediately opens on permanent failure", () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 5,
    resetTimeoutMs: 10000
  });

  breaker.recordFailure({ permanent: true });
  assert.equal(breaker.getState().state, CircuitState.OPEN);
  assert.equal(breaker.getState().permanentFailure, true);
  assert.equal(breaker.canAttempt(), false);
});

test("CircuitBreaker transitions OPEN -> HALF_OPEN after cooldown with single probe concurrency", () => {
  let currentTime = 1000;
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 5000,
    clock: () => currentTime
  });

  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.getState().state, CircuitState.OPEN);

  // Before cooldown: blocked
  currentTime += 3000;
  assert.equal(breaker.canAttempt(), false);

  // After cooldown: first request transitions to HALF_OPEN and gets the probe slot
  currentTime += 2500; // now 6500ms since opened
  assert.equal(breaker.canAttempt(), true);
  assert.equal(breaker.getState().state, CircuitState.HALF_OPEN);

  // Concurrent request in HALF_OPEN is rejected (single probe concurrency)
  assert.equal(breaker.canAttempt(), false);

  // Probe succeeds -> CLOSED
  breaker.recordSuccess();
  assert.equal(breaker.getState().state, CircuitState.CLOSED);
  assert.equal(breaker.canAttempt(), true);
});

test("CircuitBreaker re-opens with backoff if probe fails in HALF_OPEN", () => {
  let currentTime = 1000;
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 5000,
    clock: () => currentTime
  });

  breaker.recordFailure();
  assert.equal(breaker.getState().state, CircuitState.OPEN);

  currentTime += 6000;
  assert.equal(breaker.canAttempt(), true); // enters HALF_OPEN

  // Probe fails
  breaker.recordFailure();
  assert.equal(breaker.getState().state, CircuitState.OPEN);

  // Cooldown is now doubled (5000 * 2 = 10000)
  currentTime += 6000;
  assert.equal(breaker.canAttempt(), false); // 6000 < 10000 -> still blocked

  currentTime += 5000; // 11000 > 10000 -> can attempt again
  assert.equal(breaker.canAttempt(), true);
});

test("CircuitBreaker snapshot and hydrate preserve exact backoff and state", () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 5000,
    clock: () => 50000
  });

  breaker.recordFailure();
  breaker.recordFailure(); // OPEN at 50000
  assert.equal(breaker.getState().state, CircuitState.OPEN);
  assert.equal(breaker.getState().openedAt, 50000);
  assert.equal(breaker.getState().backoffMultiplier, 1);

  const snap = breaker.snapshot();
  assert.deepEqual(snap, {
    state: "OPEN",
    consecutiveFailures: 2,
    openedAt: 50000,
    backoffMultiplier: 1,
    permanentFailure: false
  });

  const newBreaker = new CircuitBreaker({ clock: () => 50000 });
  const hydrated = newBreaker.hydrate(snap);
  assert.equal(hydrated, true);
  assert.equal(newBreaker.getState().state, CircuitState.OPEN);
  assert.equal(newBreaker.getState().openedAt, 50000);
  assert.equal(newBreaker.getState().consecutiveFailures, 2);

  // Rejects corrupted or invalid hydration data
  assert.equal(newBreaker.hydrate(null), false);
  assert.equal(newBreaker.hydrate({ state: "UNKNOWN" }), false);
  assert.equal(newBreaker.hydrate({ state: "OPEN", consecutiveFailures: -1 }), false);
  assert.equal(newBreaker.hydrate({ state: "OPEN", consecutiveFailures: 1, openedAt: "invalid" }), false);
  assert.equal(newBreaker.hydrate({ state: "OPEN", consecutiveFailures: 1, openedAt: 100, backoffMultiplier: 0.5 }), false);
  assert.equal(newBreaker.hydrate({ state: "OPEN", consecutiveFailures: 1, openedAt: 100, backoffMultiplier: 7 }), false, "Rejects backoffMultiplier > MAX_BACKOFF_MULTIPLIER (6)");
  assert.equal(newBreaker.hydrate({ state: "OPEN", consecutiveFailures: 1, openedAt: 100, backoffMultiplier: 64 }), false, "Rejects backoffMultiplier 64");
});

test("CircuitBreaker caps cooldown to MAX_BACKOFF_MS (30 minutes) even with large resetTimeoutMs", async () => {
  const { MAX_BACKOFF_MS } = await import("../lib/memory-router/circuit-breaker.js");
  assert.equal(MAX_BACKOFF_MS, 1_800_000, "MAX_BACKOFF_MS must be 30 minutes (1,800,000 ms)");

  let currentTime = 1000;
  // resetTimeoutMs is 1 hour (3,600,000ms), multiplier is 4 -> product is 14,400,000ms (4 hours)
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 3_600_000,
    clock: () => currentTime
  });

  breaker.recordFailure(); // OPEN at 1000
  assert.equal(breaker.getState().state, CircuitState.OPEN);

  // Hydrate with multiplier 4
  breaker.hydrate({
    state: "OPEN",
    consecutiveFailures: 1,
    openedAt: 1000,
    backoffMultiplier: 4,
    permanentFailure: false
  });

  // Check right before 30 minutes cap: 1000 + 1,799,000 = 1,800,000
  currentTime = 1000 + 1_799_000;
  assert.equal(breaker.canAttempt(), false, "Must still be blocked before 30-minute cap expires");

  // Check after 30 minutes cap: 1000 + 1_800_001 = 1,801,001
  currentTime = 1000 + 1_800_001;
  assert.equal(breaker.canAttempt(), true, "Must be allowed once 30-minute cap has passed, ignoring multi-hour backoff");
  assert.equal(breaker.getState().state, CircuitState.HALF_OPEN);
});

