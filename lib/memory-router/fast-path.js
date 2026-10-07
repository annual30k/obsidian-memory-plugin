const SENSITIVE_PATTERNS = [
  // Conservative credential label check (no min length required, catches password=hunter2, secret: xyz, etc.)
  /(?:password|passwd|pwd|client[_-]?secret|api[_-]?key|auth[_-]?token|access[_-]?key|private[_-]?key)\s*[:=]\s*\S+/iu,
  // Environment variable secret exports
  /(?:export\s+)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\s*=\s*\S+/iu,
  // JWT tokens (3 base64url segments separated by dots)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  // Quoted keys in JSON / YAML / code: "apiKey": "…", 'token': '…'
  /["'](?:api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd)["']\s*[:=]\s*["'][^"'\s]{8,}["']/iu,
  // Chinese labels: "密码是 hunter22", "密钥：…", "令牌为 …"
  /(?:密码|口令|密钥|秘钥|私钥|令牌)\s*(?:是|为|[:：=])\s*\S{6,}/u,
  // Credentials inside a URL: postgres://user:pass@host, https://user:token@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/iu,
  // OpenAI / Anthropic / generic "sk-" keys, including sk-proj-, sk-ant-api03-, sk-svcacct-
  /\bsk-[a-zA-Z0-9]{20,}\b/u,
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{23,}/u,
  // Stripe live/test keys
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  // Slack tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/u,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  // Hugging Face, GitLab, npm tokens
  /\bhf_[A-Za-z0-9]{30,}\b/u,
  /\bglpat-[A-Za-z0-9_-]{20,}/u,
  /\bnpm_[A-Za-z0-9]{36}\b/u,
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

// Codex's own background task that proposes suggestions ("# Overview … Generate 0 to 3 hyperpersonalized
// suggestions …", 2026-09-28) is sent through UserPromptSubmit like a user turn. OpenClaw's heartbeat poll is
// only a system message when it is the whole message (ClawConnect keeps "[OpenClaw heartbeat poll] please
// explain" as real chat).
const SYSTEM_MESSAGE = /^(?:__[A-Za-z0-9_]{3,}__\s*$|\[cron:[^\]\n]*\]|\[OpenClaw cron wake\]|\[?OpenClaw heartbeat poll\]?\s*$|# Overview\s+Generate \d+ to \d+ hyperpersonalized suggestions)/u;

// Context a host or bridge adds to the user's message, which is not the user's words. Seen on real turns:
// Codex wraps blocks such as <in-app-browser-context source="ambient-ui-state">, <environment_context>,
// <codex_internal_context>, <recommended_plugins> and "# AGENTS.md instructions … <INSTRUCTIONS>"; Hermes
// appends "[Hermes runtime context]" and the ClawConnect bridge appends "[ClawConnect mobile bridge]" and
// "[ClawConnect mobile turn]" (sourceRunId / sessionKey metadata) paragraphs (an ambient-UI block was staged
// as a "user statement", 2026-09-29).
const HOST_CONTEXT_BLOCK = /<((?:[a-z]+[_-])+context|recommended_plugins|INSTRUCTIONS)\b[^>]*>[\s\S]*?<\/\1>/gu;
const HOST_CONTEXT_HEADING = /^# AGENTS\.md instructions\b[^\n]*$/gmu;
const HOST_CONTEXT_PARAGRAPH = /(?:^|\n)\[(?:Hermes runtime context|ClawConnect mobile (?:bridge|turn))\][\s\S]*?(?=\n[ \t]*\n|$)/gu;
// Codex puts attached files first and the request after this heading.
const CODEX_REQUEST_MARKER = /\n## My request:\s*\n/u;

/** The user's own words: `text` without host-injected context (see above). */
export function stripHostContext(text) {
  if (typeof text !== "string") return "";
  let out = text;
  const marker = /^\s*# Files mentioned by the user:/u.test(out) ? CODEX_REQUEST_MARKER.exec(out) : null;
  if (marker) out = out.slice(marker.index + marker[0].length);
  return out.replace(HOST_CONTEXT_BLOCK, "").replace(HOST_CONTEXT_HEADING, "").replace(HOST_CONTEXT_PARAGRAPH, "")
    .replace(/\n{3,}/gu, "\n\n").trim();
}

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
  // "记录下来：……", "以后记得……", "记得下次……" ("我记得……" / "记得吗" are recall, see above).
  /记录下来|(?:以后|下次|之后|往后)(?:都)?(?:要)?记得|记得(?:以后|下次|之后|往后)/u,
  /\b(?:remember (?:this|that)|don'?t forget|do not forget|keep (?:this|that) in mind|note (?:this|that) down|save (?:this|that|it) (?:to|in) (?:memory|the vault|obsidian)|save to memory|(?:record|store) (?:this|that|it) (?:in|to|into) (?:memory|the vault|obsidian|your notes))\b/iu
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

// A statement of something that should still hold later: a rule or convention ("以后提交信息都用中文",
// "测试统一放 tests/", "别再用 npm"), or a lasting personal fact or preference ("我对花生过敏",
// "我的减脂目标是每天 1800 大卡"). Deterministic backup for the durable-statement head, which scores
// personal facts low. Only used to queue the prompt for the session digest, never to hint or enforce.
const DURABLE_STATEMENT_PATTERNS = [
  /(?:以后|今后|往后|从现在起|从今天起|接下来)[^。！？?!]{0,30}?(?:都|一律|统一|必须|一定要|不要|别|不再|只用|改用|改成)/u,
  /(?:我们|咱们|团队|项目)?(?:约定|规定|惯例|规矩)(?:是|为|好了|一下)?[:：，,]?/u,
  /(?:统一|一律)(?:用|使用|采用|放|放在|写|走)|(?:别|不要|禁止)再?(?:用|使用)\S/u,
  /我(?:对.{1,12}过敏|不吃|不喝|吃素|偏好|习惯(?:用|于)|更喜欢|喜欢用)/u,
  /我的.{0,12}(?:目标|偏好|习惯|过敏|饮食|作息|工作时间|时区)(?:是|为|定为|[:：])/u,
  /\b(?:from now on|going forward|always use|never use|by default,? use|we (?:always|never|agreed))\b/iu
];
const QUESTION_SHAPE = /[?？]\s*$|(?:吗|呢|么|嘛)\s*[。.!！~]?\s*$|(?:什么|哪个|哪些|哪里|怎么|如何|为什么|为啥|是否|有没有|是不是)|^(?:what|how|why|which|is|are|do|does|did|can|could|should)\b/iu;

// Narrower than QUESTION_SHAPE: a save request may contain "怎么" or "为什么" in what it asks to keep.
const ASKS_BACK = /[?？]\s*$|(?:吗|呢|么|嘛)\s*[。.!！~]?\s*$|还记得|你记得(?!以后|下次|之后|往后)|记不记得|记得吗|^(?:do|did|can|could|will) you\b/iu;

export function looksLikeDurableStatement(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 300 || QUESTION_SHAPE.test(trimmed)) return false;
  return DURABLE_STATEMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Quoted, pasted or code text is data the user shows, not a request: "记住" inside it does not count.
// In a long message (a pasted document, a host's own task prompt) only the opening and closing lines are
// where a request to save sits; "Remember that Codex can …" 5 000 characters into Codex's suggestion
// prompt, or a pasted note quoting "记住", is not one.
const LONG_TEXT = 800;
const EDGE = 300;
function ownWords(text) {
  const edges = text.length > LONG_TEXT ? `${text.slice(0, EDGE)}\n${text.slice(-EDGE)}` : text;
  return edges
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/[“"「『][^”"」』\n]{0,400}[”"」』]/gu, " ")
    .split("\n").filter((line) => !/^\s*>/u.test(line)).join("\n");
}

export function isGenericQuestion(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 160 || SELF_REFERENCE.test(trimmed)) return false;
  return GENERIC_QUESTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Replace every credential-looking match with a marker. Returns { text, redacted }. */
export function redactSecrets(text) {
  if (typeof text !== "string" || !text) return { text: typeof text === "string" ? text : "", redacted: false };
  let out = text;
  let redacted = false;
  for (const pattern of SENSITIVE_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    out = out.replace(global, () => { redacted = true; return "[REDACTED]"; });
  }
  return { text: out, redacted };
}

export function containsSensitiveContent(text) {
  if (typeof text !== "string") return false;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectScope(text) {
  if (typeof text !== "string") return "project";
  // Whole words only: "globalThis", "global.css" or "npm i -g" are not a request for the Global scope.
  if (/(?:全局|跨项目|所有项目|\bglobal(?:ly)?\b(?![.\w])|\buser-wide\b)/iu.test(text)) {
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

  // Host-injected context is not the user's: a message that is nothing else is a host-internal message.
  const trimmed = stripHostContext(text);
  if (!trimmed) {
    return {
      action: "skip",
      reason: "system_message",
      recallRecommended: false,
      captureRecommended: false,
      captureCategory: null,
      score: null,
      scope: null
    };
  }

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

  // 1b. Host-internal messages, not the user's words: OpenClaw memory-core's "__openclaw_memory_core_…__"
  // dreaming token (it ran without a cron trigger and was staged as a "user statement", 2026-09-27),
  // "[cron:<id> <name>] …" job prompts and "[OpenClaw cron wake]".
  if (SYSTEM_MESSAGE.test(trimmed)) {
    return {
      action: "skip",
      reason: "system_message",
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
  const own = ownWords(trimmed);
  const question = ASKS_BACK.test(own.trim());
  const recallAsked = EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(trimmed));

  // 3. Explicit Remember / Note-taking Intent. Checked before recall so "记住，我们约定……" keeps its
  // end-of-turn check. A question about the past or about what was saved ("你还记得……吗", "写进记忆了吗")
  // stays a recall; a request phrased as a question ("你看这些有需要沉淀成长期记忆的吗") is still a save.
  if (!(question && recallAsked) && EXPLICIT_REMEMBER_PATTERNS.some((pattern) => pattern.test(own))) {
    return {
      action: "force_capture",
      reason: "explicit_remember_intent",
      recallRecommended: false,
      captureRecommended: true,
      captureCategory: "decision",
      ...(recallAsked ? { alsoRecall: true } : {}),
      score: 1.0,
      scope
    };
  }

  // 4. Explicit Recall Intent
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

  // 5. Explicit Pitfall Intent ("记一下这个坑"); "这个库有哪些踩坑点？" is a question, left to Laya.
  for (const pattern of EXPLICIT_PITFALL_PATTERNS) {
    if (!question && pattern.test(own)) {
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

  // 6. Ambiguous: Consult Laya
  return { action: "consult_laya", reason: "needs_judgment" };
}
