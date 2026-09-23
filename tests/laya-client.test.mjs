import test from "node:test";
import assert from "node:assert/strict";
import { LayaClient, LayaHttpError } from "../lib/memory-router/client.js";

test("LayaClient executes successful health and recall requests", async () => {
  const mockFetch = async (url, options) => {
    if (url.endsWith("/health")) {
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
    if (url.endsWith("/judge/recall")) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json; charset=utf-8");
      const body = JSON.parse(options.body);
      assert.equal(body.text, "test query");
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () => JSON.stringify({
          requires_memory: 0.95,
          confidence: 0.9,
          scope: { project: 0.95 }
        })
      };
    }
    if (url.endsWith("/judge/capture")) {
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ capture_score: 0.91, confidence: 0.88, category: "decision", scope: "project" }) };
    }
    if (url.endsWith("/judge/relation")) {
      const body = JSON.parse(options.body);
      assert.equal(body.candidate, "new note");
      assert.equal(body.existing, "old note");
      return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ relation: "supersession", confidence: 0.82 }) };
    }
    throw new Error(`Unhandled url: ${url}`);
  };

  const client = new LayaClient("http://127.0.0.1:18791", { fetch: mockFetch });
  const health = await client.healthCheck();
  assert.equal(health.service, "laya-memory-judge");

  const recall = await client.judgeRecall({ text: "test query" });
  assert.equal(recall.requiresMemory, 0.95);
  const capture = await client.judgeCapture({ text: "completed task" });
  assert.equal(capture.category, "decision");
  assert.equal(capture.scope, "project");
  const relation = await client.judgeRelation({ candidate: "new note", existing: "old note" });
  assert.equal(relation.relation, "supersession");
});

test("LayaClient attaches Bearer token when provided", async () => {
  let authHeader = null;
  const mockFetch = async (url, options) => {
    authHeader = options.headers.Authorization;
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
  };

  const client = new LayaClient("http://127.0.0.1:18791", {
    token: "my-secret-token",
    fetch: mockFetch
  });

  await client.healthCheck();
  assert.equal(authHeader, "Bearer my-secret-token");
});

test("LayaClient strictly rejects HTTP redirects", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 302,
    type: "opaqueredirect"
  });

  const client = new LayaClient("http://127.0.0.1:18791", { fetch: mockFetch });
  await assert.rejects(
    () => client.healthCheck(),
    (err) => err instanceof LayaHttpError && err.permanent === true && err.message.includes("redirects are forbidden")
  );
});

test("LayaClient enforces max response byte limit", async () => {
  const hugePayload = "x".repeat(1000);
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-length", "1000"]]),
    text: async () => hugePayload
  });

  const client = new LayaClient("http://127.0.0.1:18791", {
    fetch: mockFetch,
    maxResponseBytes: 100 // Set limit to 100 bytes
  });

  await assert.rejects(
    () => client.healthCheck(),
    (err) => err instanceof LayaHttpError && err.message.includes("exceeds maximum allowed size")
  );
});

test("LayaClient aborts chunked stream reader when payload exceeds limit without Content-Length", async () => {
  // Simulate chunked streaming via body.getReader()
  let chunksRead = 0;
  const mockReader = {
    async read() {
      chunksRead++;
      if (chunksRead <= 5) {
        return { done: false, value: new Uint8Array(50) }; // 5 * 50 = 250 bytes
      }
      return { done: true, value: undefined };
    }
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map(), // No Content-Length header!
    body: {
      getReader: () => mockReader
    }
  });

  const client = new LayaClient("http://127.0.0.1:18791", {
    fetch: mockFetch,
    maxResponseBytes: 100 // 100 byte limit
  });

  await assert.rejects(
    () => client.healthCheck(),
    (err) => err instanceof LayaHttpError && err.message.includes("exceeds maximum allowed size")
  );
});

test("LayaClient handles request timeout and clears timer", async () => {
  let cleared = false;
  const mockTimers = {
    setTimeout: (fn, ms) => {
      // Simulate timeout trigger immediately
      const id = { id: 1 };
      fn();
      return id;
    },
    clearTimeout: () => {
      cleared = true;
    }
  };

  const mockFetch = async (_url, { signal }) => {
    if (signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };

  const client = new LayaClient("http://127.0.0.1:18791", {
    fetch: mockFetch,
    timers: mockTimers
  });

  await assert.rejects(
    () => client.healthCheck({ timeout: 50 }),
    (err) => err instanceof LayaHttpError && err.message.includes("timed out")
  );

  assert.equal(cleared, true);
});

test("LayaClient categorizes auth and server errors", async () => {
  const client401 = new LayaClient("http://127.0.0.1:18791", {
    fetch: async () => ({ ok: false, status: 401, headers: new Map(), text: async () => "unauthorized" })
  });

  await assert.rejects(
    () => client401.healthCheck(),
    (err) => err instanceof LayaHttpError && err.auth === true && err.permanent === true
  );

  const client500 = new LayaClient("http://127.0.0.1:18791", {
    fetch: async () => ({ ok: false, status: 500, headers: new Map(), text: async () => "error" })
  });

  await assert.rejects(
    () => client500.healthCheck(),
    (err) => err instanceof LayaHttpError && err.status === 500 && err.permanent === false
  );
});

test("truncateForInference preserves head and tail for inputs exceeding maxChars", async () => {
  const { truncateForInference } = await import("../lib/memory-router/client.js");
  assert.equal(truncateForInference("short text", 2048), "short text");

  const head = "START_HEAD_SECTION_12345";
  const tail = "END_TAIL_SECTION_67890";
  const middle = "x".repeat(3000);
  const longText = `${head}${middle}${tail}`;

  const truncated = truncateForInference(longText, 2048);
  assert.ok(truncated.length <= 2048, "Truncated text must not exceed maxChars");
  assert.ok(truncated.startsWith(head), "Truncated text must retain head");
  assert.ok(truncated.endsWith(tail), "Truncated text must retain tail");
  assert.ok(truncated.includes("\n...\n"), "Truncated text must include truncation marker");
});
