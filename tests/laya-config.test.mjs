import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_MEMORY_JUDGE,
  parseConfig,
  parseConfigs,
  parseMemoryJudgeConfig,
  validateLoopbackEndpoint
} from "../lib/config.js";

test("DEFAULT_MEMORY_JUDGE has expected safe defaults", () => {
  assert.equal(DEFAULT_MEMORY_JUDGE.mode, "auto");
  assert.equal(DEFAULT_MEMORY_JUDGE.endpoint, null);
  assert.equal(DEFAULT_MEMORY_JUDGE.discoveryInterval, 300000);
  assert.equal(DEFAULT_MEMORY_JUDGE.serviceFile, join(homedir(), ".laya", "service.json"));
  assert.equal(DEFAULT_MEMORY_JUDGE.timeout, 1000);
  assert.equal(DEFAULT_MEMORY_JUDGE.coldStartTimeout, 7500);
  assert.equal(DEFAULT_MEMORY_JUDGE.healthTimeout, 200);
  assert.equal(DEFAULT_MEMORY_JUDGE.recallThreshold, 0.50);
  assert.equal(DEFAULT_MEMORY_JUDGE.captureThreshold, 0.75);
  assert.equal(DEFAULT_MEMORY_JUDGE.proactiveCapture, true);
  assert.equal(DEFAULT_MEMORY_JUDGE.layaCapture, false);
  assert.equal(DEFAULT_MEMORY_JUDGE.consecutiveFailures, 2);
  assert.equal(DEFAULT_MEMORY_JUDGE.resetTimeout, 300000);
  assert.ok(Object.isFrozen(DEFAULT_MEMORY_JUDGE));
});

test("validateLoopbackEndpoint accepts only strict HTTP loopback IPs", () => {
  assert.equal(validateLoopbackEndpoint("http://127.0.0.1:18791"), "http://127.0.0.1:18791");
  assert.equal(validateLoopbackEndpoint("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(validateLoopbackEndpoint("http://[::1]:18791"), "http://[::1]:18791");

  // Rejections
  const invalid = [
    "http://localhost:18791", // Prohibit localhost DNS ambiguity
    "https://127.0.0.1:18791", // Prohibit HTTPS
    "http://0.0.0.0:18791", // Prohibit 0.0.0.0
    "http://192.168.1.1:18791", // Prohibit LAN
    "http://169.254.169.254:80", // Prohibit cloud metadata
    "http://127.0.0.1", // Missing port
    "http://127.0.0.1:18791/subpath", // Non-root path
    "http://127.0.0.1:18791?query=1", // Query
    "http://127.0.0.1:18791#hash", // Hash
    "http://user:pass@127.0.0.1:18791", // Userinfo
    "ftp://127.0.0.1:18791",
    "",
    null,
    123
  ];

  for (const url of invalid) {
    assert.throws(
      () => validateLoopbackEndpoint(url),
      TypeError,
      `Expected ${String(url)} to be rejected`
    );
  }
});

test("parseMemoryJudgeConfig validates valid options and rejects invalid fields", () => {
  assert.deepEqual(parseMemoryJudgeConfig(undefined), DEFAULT_MEMORY_JUDGE);
  assert.deepEqual(parseMemoryJudgeConfig(null), DEFAULT_MEMORY_JUDGE);

  const custom = parseMemoryJudgeConfig({
    mode: "manual",
    endpoint: "http://127.0.0.1:19000",
    timeout: 1500,
    coldStartTimeout: 6000,
    healthTimeout: 300,
    recallThreshold: 0.85,
    consecutiveFailures: 3,
    resetTimeout: 60000,
    captureThreshold: 0.80,
    proactiveCapture: false
  });

  assert.equal(custom.mode, "manual");
  assert.equal(custom.endpoint, "http://127.0.0.1:19000");
  assert.equal(custom.timeout, 1500);
  assert.equal(custom.coldStartTimeout, 6000);
  assert.equal(custom.healthTimeout, 300);
  assert.equal(custom.recallThreshold, 0.85);
  assert.equal(custom.captureThreshold, 0.80);
  assert.equal(custom.proactiveCapture, false);
  assert.equal(custom.consecutiveFailures, 3);
  assert.equal(custom.resetTimeout, 60000);

  // Reject manual mode without endpoint
  assert.throws(
    () => parseMemoryJudgeConfig({ mode: "manual" }),
    (err) => err instanceof TypeError && err.message.includes("endpoint is required when mode is manual")
  );

  // Reject invalid mode
  assert.throws(() => parseMemoryJudgeConfig({ mode: "enabled" }), TypeError);

  // Reject unknown fields
  assert.throws(() => parseMemoryJudgeConfig({ arbitrary: true }), TypeError);

  // Reject out-of-range numbers
  assert.throws(() => parseMemoryJudgeConfig({ timeout: 10 }), TypeError);
  assert.throws(() => parseMemoryJudgeConfig({ recallThreshold: 1.5 }), TypeError);
  assert.throws(() => parseMemoryJudgeConfig({ captureThreshold: 1.5 }), TypeError);
  assert.throws(() => parseMemoryJudgeConfig({ proactiveCapture: "true" }), TypeError);
  assert.throws(() => parseMemoryJudgeConfig({ layaCapture: "yes" }), TypeError);
  assert.equal(parseMemoryJudgeConfig({ layaCapture: true }).layaCapture, true);
  assert.throws(() => parseMemoryJudgeConfig({ consecutiveFailures: 0 }), TypeError);
  assert.throws(() => parseMemoryJudgeConfig({ discoveryInterval: 500 }), TypeError);
});

test("parseConfigs supports top-level memoryJudge alongside agentConfigs", () => {
  const result = parseConfigs({
    agentConfigs: {
      owner: { vaultPath: "/path/to/vault" }
    },
    memoryJudge: {
      mode: "auto"
    }
  });

  assert.equal(result.size, 1);
  assert.equal(result.get("owner").vaultPath, "/path/to/vault");
  assert.equal(result.memoryJudge.mode, "auto");
});

test("parseConfigs defaults memoryJudge to mode auto for unconfigured setups", () => {
  const legacySingle = parseConfigs({
    agentId: "owner",
    vaultPath: "/path/to/vault"
  });
  assert.equal(legacySingle.memoryJudge.mode, "auto");

  const legacyMulti = parseConfigs({
    agentConfigs: {
      owner: { vaultPath: "/path/to/vault" }
    }
  });
  assert.equal(legacyMulti.memoryJudge.mode, "auto");
});

test("parseMemoryJudgeConfig expands ~ in serviceFile to home directory", () => {
  const custom = parseMemoryJudgeConfig({
    serviceFile: "~/.custom-laya/service.json"
  });
  assert.equal(custom.serviceFile, join(homedir(), ".custom-laya", "service.json"));
});

