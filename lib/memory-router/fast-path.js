const SENSITIVE_PATTERNS = [
  // Conservative credential label check (no min length required, catches password=hunter2, secret: xyz, etc.)
  /(?:password|passwd|pwd|client[_-]?secret|api[_-]?key|auth[_-]?token|access[_-]?key|private[_-]?key)\s*[:=]\s*\S+/iu,
  // Environment variable secret exports
  /(?:export\s+)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\s*=\s*\S+/iu,
  // JWT tokens (3 base64url segments separated by dots)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  // OpenAI & generic AI model tokens
  /\bsk-[a-zA-Z0-9]{20,}\b/u,
  // GitHub Personal Access Tokens & Fine-Grained Tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/u,
  // AWS Access Key IDs
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  // Private Key Blocks
  /-----BEGIN\s+[A-Z\s]+PRIVATE KEY-----/u,
  // HTTP Authorization Bearer tokens
  /Bearer\s+[a-zA-Z0-9._~+/-]{10,}/iu
];

const TRIVIAL_GREETINGS = new Set([
  "你好", "您好", "hi", "hello", "hey",
  "谢谢", "多谢", "thx", "thanks", "thank you",
  "好的", "好", "ok", "okay", "收到", "明白",
  "早", "早安", "晚安", "再见", "bye"
]);

const EXPLICIT_RECALL_PATTERNS = [
  /(?:@memory|#memory)\b/iu,
  /(?:回忆|检索|查找|搜索|查一下|找一下|回忆一下|翻一下).*(?:记忆|知识库|之前|上次|历史|决策|踩坑|pitfall|decision)/u,
  /(?:之前|上次|过去).*(?:怎么解决|怎么配置|怎么处理|方案是什么|结论是什么|讨论了什么|踩过什么坑)/u,
  /\b(?:recall|search memory|check memory|previous solution|past decision|lookup memory)\b/iu
];

const EXPLICIT_REMEMBER_PATTERNS = [
  /(?:记住|存入记忆|记入知识库|记录这个|记下来|别忘了)/u,
  /\b(?:remember this|save to memory|record this|store this)\b/iu
];

export function evaluateFastPath(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { action: "skip", reason: "empty_text", recallRecommended: false };
  }

  const trimmed = text.trim();

  // 1. Sensitive Secret Shield
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { action: "skip", reason: "sensitive_content", recallRecommended: false };
    }
  }

  // 2. Trivial Greetings / Acknowledgments
  if (trimmed.length <= 20) {
    const cleaned = trimmed.toLowerCase().replace(/^[!?,.，。！？\s]+|[!?,.，。！？\s]+$/gu, "");
    if (TRIVIAL_GREETINGS.has(cleaned)) {
      return { action: "skip", reason: "trivial_greeting", recallRecommended: false };
    }
  }

  // 3. Explicit Recall Intent
  for (const pattern of EXPLICIT_RECALL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { action: "force_recall", reason: "explicit_recall_intent", recallRecommended: true, score: 1.0 };
    }
  }

  // 4. Explicit Remember / Note-taking Intent (Not a recall task)
  for (const pattern of EXPLICIT_REMEMBER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { action: "skip", reason: "explicit_remember_intent", recallRecommended: false };
    }
  }

  // 5. Ambiguous: Consult Laya
  return { action: "consult_laya", reason: "needs_judgment" };
}
