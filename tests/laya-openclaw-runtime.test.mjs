import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";

const VALID_HEALTH_JSON = JSON.stringify({
  service: "laya-memory-judge",
  status: "ok",
  api_version: "1",
  model_status: "ready",
  capabilities: ["recall", "scope"]
});

const VALID_RECALL_JSON = JSON.stringify({
  requires_memory: 0.92,
  confidence: 0.96,
  scope: { project: 0.95 }
});

function setup(config) {
  const calls = [];
  let disposeHandler = null;
  const api = {
    pluginConfig: config,
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    on: (name, handler) => calls.push({ name, handler }),
    onDispose: (fn) => { disposeHandler = fn; }
  };
  plugin.register(api);
  return {
    hook: calls[0]?.handler,
    dispose: disposeHandler
  };
}

test("OpenClaw runtime always retains base guidance and connection data", async () => {
  const { hook } = setup({
    agentId: "owner",
    vaultPath: "/my/test/vault"
  });

  const res = hook({}, { agentId: "owner", trigger: "user" });
  assert.ok(res.prependContext.includes("[Obsidian Memory]"));
  assert.ok(res.prependContext.includes("[End Obsidian Memory]"));
  assert.ok(res.prependContext.includes("/my/test/vault"));
  assert.ok(!res.prependContext.includes("[Laya Memory Judge"));
});

test("OpenClaw runtime appends recall recommendation on user trigger when Laya threshold is met", async () => {
  const origFetch = globalThis.fetch;
  let healthCalls = 0;
  let recallCalls = 0;

  try {
    globalThis.fetch = async (url) => {
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

    const { hook, dispose } = setup({
      agentId: "owner",
      vaultPath: "/my/test/vault",
      memoryJudge: {
        mode: "manual",
        endpoint: "http://127.0.0.1:18791",
        recallThreshold: 0.70
      }
    });

    const promise = hook(
      { prompt: "Which approach resolved that architectural conflict?" },
      { agentId: "owner", trigger: "user" }
    );
    const res = await promise;

    // 1. Assert initial health and recall were called
    assert.equal(healthCalls, 1);
    assert.equal(recallCalls, 1);

    // 2. Base security guidance is intact
    assert.ok(res.prependContext.includes("[Obsidian Memory]"));
    assert.ok(res.prependContext.includes("[End Obsidian Memory]"));
    assert.ok(res.prependContext.includes("/my/test/vault"));

    // 3. Recall recommendation is appended before [End Obsidian Memory]
    assert.ok(res.prependContext.includes("[Laya Memory Judge: recall recommended (scope: project). Read the obsidian-memory skill, then search the Vault before proceeding.]"));
    const judgeIdx = res.prependContext.indexOf("[Laya Memory Judge");
    const endIdx = res.prependContext.indexOf("[End Obsidian Memory]");
    assert.ok(judgeIdx < endIdx, "Laya suggestion must be placed before [End Obsidian Memory]");

    if (dispose) dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("OpenClaw runtime performs zero network calls for non-user triggers", async () => {
  const origFetch = globalThis.fetch;
  let fetchCount = 0;

  try {
    globalThis.fetch = async () => {
      fetchCount++;
      return { ok: true, status: 200, text: async () => "{}" };
    };

    const { hook, dispose } = setup({
      agentId: "owner",
      vaultPath: "/my/test/vault",
      memoryJudge: {
        mode: "manual",
        endpoint: "http://127.0.0.1:18791"
      }
    });

    // 1. Heartbeat trigger -> 0 network calls
    const res1 = hook({ prompt: "cron work" }, { agentId: "owner", trigger: "heartbeat" });
    assert.equal(fetchCount, 0);
    assert.ok(res1.prependContext.includes("[Obsidian Memory]"));
    assert.ok(!res1.prependContext.includes("[Laya Memory Judge"));

    // 2. Cron trigger -> 0 network calls
    const res2 = hook({ prompt: "cron work" }, { agentId: "owner", trigger: "cron" });
    assert.equal(fetchCount, 0);
    assert.ok(res2.prependContext.includes("[Obsidian Memory]"));

    // 3. System trigger -> 0 network calls
    const res3 = hook({ prompt: "system event" }, { agentId: "owner", trigger: "system" });
    assert.equal(fetchCount, 0);
    assert.ok(res3.prependContext.includes("[Obsidian Memory]"));

    if (dispose) dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("OpenClaw runtime maintains base guidance only when Laya fails", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("Laya server down");
    };

    const { hook, dispose } = setup({
      agentId: "owner",
      vaultPath: "/my/test/vault",
      memoryJudge: {
        mode: "manual",
        endpoint: "http://127.0.0.1:18791"
      }
    });

    const res = await hook(
      { prompt: "Some technical question" },
      { agentId: "owner", trigger: "user" }
    );
    assert.ok(res.prependContext.includes("[Obsidian Memory]"));
    assert.ok(res.prependContext.includes("[End Obsidian Memory]"));
    assert.ok(!res.prependContext.includes("[Laya Memory Judge"));

    if (dispose) dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("OpenClaw runtime appends proactive capture recommendation when Laya detects high-value pitfall", async () => {
  const origFetch = globalThis.fetch;
  const CAPTURE_PITFALL_JSON = JSON.stringify({
    requires_memory: 0.42 /* uncertain band: capture allowed */,
    confidence: 0.92,
    scope: { project: 0.90 },
    categories: { pitfall: 0.95, decision: 0.04, knowledge: 0.01 }
  });

  try {
    globalThis.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/health")) {
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () => VALID_HEALTH_JSON
        };
      }
      if (urlStr.endsWith("/judge/recall")) {
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () => CAPTURE_PITFALL_JSON
        };
      }
      return { ok: false, status: 404, text: async () => "" };
    };

    const { hook, dispose } = setup({
      agentId: "owner",
      vaultPath: "/my/test/vault",
      memoryJudge: {
        mode: "manual",
        endpoint: "http://127.0.0.1:18791",
        recallThreshold: 0.70,
        captureThreshold: 0.75,
        proactiveCapture: true, layaCapture: true
      }
    });

    const promise = hook(
      { prompt: "排查发现在 macOS 下不能通过 PID 强杀，因为 PID 复用会导致误杀，必须通过 /shutdown 停机。" },
      { agentId: "owner", trigger: "user" }
    );
    const res = await promise;

    assert.ok(res.prependContext.includes("[Obsidian Memory]"));
    assert.ok(res.prependContext.includes("[End Obsidian Memory]"));
    assert.ok(
      res.prependContext.includes("[Laya Memory Judge: high-value pitfall detected (scope: project). Proactively stage candidate note to project inbox/ with status: pending-ingest upon concluding task.]"),
      "Must include pitfall proactive capture instruction"
    );

    if (dispose) dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

