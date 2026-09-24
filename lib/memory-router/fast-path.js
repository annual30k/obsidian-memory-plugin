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
  /(?:回忆|检索|查找|搜索|查一下|找一下|回忆一下|翻一下).*(?:记忆|知识库|之前|上次|历史|决策|踩坑|偏好|pitfall|decision|preference)/u,
  /(?:之前|上次|过去).*(?:怎么解决|怎么配置|怎么处理|方案是什么|结论是什么|讨论了什么|踩过什么坑)/u,
  /\b(?:recall|search memory|check memory|previous solution|past decision|lookup memory)\b/iu,
  // "Do it the way we did / agreed before": explicit references to earlier work or conventions.
  // Laya scored several of these near 0 during tuning, so they are decided here.
  /(?:照|按)(?:老规矩|惯例|之前|上次|以前|我们|咱们|团队)/u,
  /(?:和|跟|同)(?:上次|之前|以前|上回)一样/u,
  /(?:延续|继续)(?:前面|之前|上次|昨天|前天|上周)/u,
  /(?:咱们|我们)(?:定的|约定|商量好|说好)/u,
  // "Did we write this down anywhere?": asking whether a record already exists.
  /(?:有没有|是否|有无|之前)(?:记录|记下|记过|写过|存过|沉淀)/u,
  /\b(?:did we (?:note|record|write down|document)|do we have (?:a )?(?:note|record))\b/iu,
  // "Why did we do X back then": asking for the reason behind an earlier decision.
  /(?:当时|当初|那时候?)(?:为什么|为何|怎么|是怎么|选了?|定了?|用了?)/u,
  // Not decided here: "改成之前的", "撤销上次的提交", "继续没做完的". Labelled real prompts showed these
  // mostly depend on the current conversation or on git history, not on long-term memory.
  // "Do you remember ...", "I remember there was ...", "did it all go into long-term memory?"
  /(?:还记得|你记得|记得吗|我记得|记不记得)/u,
  /(?:写到|写入|写进|记到|存到|沉淀到)了?.{0,8}(?:记忆|obsidian|vault|知识库).{0,4}(?:了吗|了没|没有)/iu,
  /\b(?:remind me|how did we|what did we|last few (?:releases|times)|do you remember)\b/iu,
  // Explicitly sending the agent to the knowledge base: "去obsidian中验证", "通过obsidian去查找", "结合vault看看".
  // ("obsidian-memory" is the plugin's own name, not the Vault.)
  /(?:查看|查查|查一下|去查|查|看看|去看|去|结合|通过|使用|用|参考|对照|翻翻?)\s*(?:一下\s*)?(?:obsidian(?![-\s]*memory)|vault|知识库)/iu,
  /\b(?:as usual|like (?:last time|before)|the way we (?:agreed|decided|did it)|where we left off|did we (?:decide|agree|settle)|we (?:agreed|decided|settled) on|our (?:usual|conventions?|agreed))\b/iu
];

const EXPLICIT_REMEMBER_PATTERNS = [
  // "记住密码 / 记住我 / 记住登录状态" is a login feature, not a request to remember something.
  /记住(?!密码|账号|帐号|用户名|登录|我的?(?:账号|帐号|密码|登录)?(?:[\s，。！？,.!?的]|$))|(?:存入记忆|记入知识库|记录这个|记录一下|记一下|记下来|别忘了)/u,
  // "写到 agent.md 中", "写入到 obsidian 中", "沉淀成长期记忆", "给你定一条规则".
  /(?:写到|写在|写进|写入到?|记到|存到)\s*(?:agents?\.md|claude\.md|gemini\.md|obsidian|长期记忆|记忆|vault|知识库)/iu,
  /沉淀(?:成|为|到)?(?:长期)?记忆|(?:给你)?定(?:一|几)?条规则|这(?:一)?条(?:规则|原则)你/u,
  // "那帮我记忆吧", "这个要长期记忆", "把这个记录放到agent.md中".
  /帮我记(?:忆|下|住)|(?:要|需要|作为)长期记忆|(?:放到|放进|加到|加进|同步到|更新到)\s*(?:agents?\.md|memory(?:\.md)?|长期记忆)/iu,
  /\b(?:remember this|save to memory|record this|store this)\b/iu
];

const EXPLICIT_PITFALL_PATTERNS = [
  /(?:踩坑|踩了个坑|排坑|避坑|排错教训|复盘教训|bug教训)/u,
  /\b(?:pitfall|bug lesson|gotcha|troubleshooting lesson)\b/iu
];

// A general knowledge question ("X 和 Y 有什么区别", "默认是多少", "what is ...") that does not point at
// this user's own work. Such questions share words with Vault notes by chance, so they should not be
// pushed to recall by a Vault match or a lukewarm Laya score.
const GENERIC_QUESTION_PATTERNS = [
  /(?:和|与|跟|vs\.?|versus).{1,40}(?:有什么|有啥|的)?(?:区别|差别|不同|关系)/iu,
  /(?:默认(?:是|值|的)|是什么意思|什么原理|原理是什么|怎么(?:输出|实现|解析|计算|创建|写一个)|如何(?:实现|输出|解析|计算|创建))/u,
  /(?:支持哪些|能用.{1,20}吗|是.{1,12}吗$)/u,
  /^(?:explain|what is|what's|what are|how do i|how to|difference between|is there a way)\b/iu,
  /\b(?:difference between|vs\.?)\b/iu,
  // Writing requests with the whole brief in the text: "写一篇关于灯塔历史的短文", "用 200 字介绍一下茶叶的历史".
  /(?:写|生成|起草)(?:一篇|一首|一段|一份)?.{0,24}(?:文章|作文|短文|诗|故事|文案)|^(?:用\s*\d+\s*字)?介绍一下/u,
  // Questions about the assistant itself or live facts: "你现在的版本是什么", "你可以生成图片吗", "明天天气".
  /你(?:现在)?(?:的)?(?:版本|是什么模型|是哪个模型|是最新的?版本)|你(?:可以|能|会)(?:生成|画|做|写|识别).{0,12}吗|几个可用的模型|天气/u
];
const SELF_REFERENCE = /(?:我们|咱们|我的|我之前|我说过|你之前|你上次|这个项目|本项目|项目里|项目中|仓库里|之前|上次|以前|当时|当初|原来|记得|规定|约定|规矩|惯例|\b(?:we|our|us|my|last time|previously|earlier)\b)/iu;

export function isGenericQuestion(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 160 || SELF_REFERENCE.test(trimmed)) return false;
  return GENERIC_QUESTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function containsSensitiveContent(text) {
  if (typeof text !== "string") return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectScope(text) {
  if (typeof text !== "string") return "project";
  if (/(?:全局|跨项目|global|user-wide)/iu.test(text)) {
    return "global";
  }
  return "project";
}

export function evaluateFastPath(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      action: "skip",
      reason: "empty_text",
      recallRecommended: false,
      captureRecommended: false,
      captureCategory: null,
      score: null,
      scope: null
    };
  }

  const trimmed = text.trim();

  // 1. Sensitive Secret Shield
  if (containsSensitiveContent(trimmed)) {
    return {
      action: "skip",
      reason: "sensitive_content",
      recallRecommended: false,
      captureRecommended: false,
      captureCategory: null,
      score: null,
      scope: null
    };
  }

  // 2. Trivial Greetings / Acknowledgments
  if (trimmed.length <= 20) {
    const cleaned = trimmed.toLowerCase().replace(/^[!?,.，。！？\s]+|[!?,.，。！？\s]+$/gu, "");
    if (TRIVIAL_GREETINGS.has(cleaned)) {
      return {
        action: "skip",
        reason: "trivial_greeting",
        recallRecommended: false,
        captureRecommended: false,
        captureCategory: null,
        score: null,
        scope: null
      };
    }
  }

  const scope = detectScope(trimmed);

  // 3. Explicit Recall Intent
  for (const pattern of EXPLICIT_RECALL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        action: "force_recall",
        reason: "explicit_recall_intent",
        recallRecommended: true,
        captureRecommended: false,
        captureCategory: null,
        score: 1.0,
        scope
      };
    }
  }

  // 4. Explicit Pitfall Intent
  for (const pattern of EXPLICIT_PITFALL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        action: "force_capture",
        reason: "explicit_pitfall_intent",
        recallRecommended: false,
        captureRecommended: true,
        captureCategory: "pitfall",
        score: 1.0,
        scope
      };
    }
  }

  // 5. Explicit Remember / Note-taking Intent
  for (const pattern of EXPLICIT_REMEMBER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        action: "force_capture",
        reason: "explicit_remember_intent",
        recallRecommended: false,
        captureRecommended: true,
        captureCategory: "decision",
        score: 1.0,
        scope
      };
    }
  }

  // 6. Ambiguous: Consult Laya
  return { action: "consult_laya", reason: "needs_judgment" };
}
