import test from "node:test";
import assert from "node:assert/strict";
import { evaluateFastPath } from "../lib/memory-router/fast-path.js";

test("evaluateFastPath handles empty or non-string input safely", () => {
  assert.equal(evaluateFastPath("").action, "skip");
  assert.equal(evaluateFastPath("   \n\t  ").action, "skip");
  assert.equal(evaluateFastPath(null).action, "skip");
  assert.equal(evaluateFastPath(undefined).action, "skip");
});

test("evaluateFastPath shields sensitive credentials and tokens", () => {
  const secretSamples = [
    "Here is my API key: sk-1234567890abcdef1234567890",
    "Authorization: Bearer my-secret-jwt-token-value-abcdef123456",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...",
    "password = 'super-secret-password-12345'"
  ];

  for (const text of secretSamples) {
    const result = evaluateFastPath(text);
    assert.equal(result.action, "skip", `Expected secret shielding for: ${text}`);
    assert.equal(result.reason, "sensitive_content");
    assert.equal(result.recallRecommended, false);
  }
});

test("evaluateFastPath short-circuits trivial greetings without calling Laya", () => {
  const greetings = [
    "你好", "您好！", "hi", "Hello", "hey!", "谢谢", "Thanks", "好的", "ok", "OK!", "收到。"
  ];

  for (const text of greetings) {
    const result = evaluateFastPath(text);
    assert.equal(result.action, "skip", `Expected greeting short-circuit for: ${text}`);
    assert.equal(result.reason, "trivial_greeting");
    assert.equal(result.recallRecommended, false);
  }
});

test("evaluateFastPath short-circuits explicit recall directives", () => {
  const recallPrompts = [
    "帮我查一下上次关于 gateway 超时的 pitfall 记录",
    "回忆一下我们之前是怎么处理跨宿主适配的？",
    "@memory 之前的方案是什么",
    "search memory for past decisions on indexing"
  ];

  for (const text of recallPrompts) {
    const result = evaluateFastPath(text);
    assert.equal(result.action, "force_recall", `Expected explicit recall for: ${text}`);
    assert.equal(result.recallRecommended, true);
    assert.equal(result.score, 1.0);
  }
});

test("evaluateFastPath short-circuits explicit remember directives without recall", () => {
  const rememberPrompts = [
    "记住这个配置：timeout 设置为 5000",
    "把刚才的踩坑存入记忆库",
    "remember this decision for later"
  ];

  for (const text of rememberPrompts) {
    const result = evaluateFastPath(text);
    assert.equal(result.action, "skip", `Expected remember bypass for: ${text}`);
    assert.equal(result.reason, "explicit_remember_intent");
    assert.equal(result.recallRecommended, false);
  }
});

test("evaluateFastPath delegates ambiguous queries to Laya", () => {
  const ambiguousQueries = [
    "如何在 OpenClaw 中配置代理？",
    "这个报错的原因可能是什么？",
    "请重构这段代码的结构"
  ];

  for (const text of ambiguousQueries) {
    const result = evaluateFastPath(text);
    assert.equal(result.action, "consult_laya");
  }
});
