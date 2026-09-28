// Isolation first: never touch the real ~/.laya, Vault or Laya service, however this file is run.
import "./setup-env.mjs";
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

test("evaluateFastPath short-circuits explicit remember directives to force_capture without recall", () => {
  const rememberPrompts = [
    "记住这个配置：timeout 设置为 5000",
    "把刚才的踩坑存入记忆库",
    "remember this decision for later"
  ];

  for (const text of rememberPrompts) {
    const result = evaluateFastPath(text);
    assert.equal(result.action, "force_capture", `Expected force_capture for: ${text}`);
    assert.equal(result.recallRecommended, false);
    assert.equal(result.captureRecommended, true);
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

test("evaluateFastPath detects scope accurately (project vs global)", () => {
  const globalRecall = evaluateFastPath("帮我回忆一下全局偏好配置");
  assert.equal(globalRecall.action, "force_recall");
  assert.equal(globalRecall.scope, "global");

  const projectRecall = evaluateFastPath("帮我回忆一下之前的踩坑记录");
  assert.equal(projectRecall.action, "force_recall");
  assert.equal(projectRecall.scope, "project");

  const globalCapture = evaluateFastPath("全局记住：默认使用 UTF-8 编码");
  assert.equal(globalCapture.action, "force_capture");
  assert.equal(globalCapture.scope, "global");

  const projectCapture = evaluateFastPath("踩坑教训：端口被占用了");
  assert.equal(projectCapture.action, "force_capture");
  assert.equal(projectCapture.scope, "project");
});

test("fast path recognises explicit 'as before / as agreed' requests without over-matching", async () => {
  const { evaluateFastPath } = await import("../lib/memory-router/fast-path.js");
  for (const text of ["照老规矩写 commit message", "按我们项目的惯例，新接口的错误码应该怎么定义", "和上次一样，把 changelog 补上", "延续前面的重构思路", "咱们定的日志格式是哪种", "Write the migration the way we agreed", "Pick up where we left off", "What did we decide about retries?", "Use the retry strategy we settled on", "Follow our usual naming conventions"]) {
    assert.equal(evaluateFastPath(text).recallRecommended, true, text);
  }
  for (const text of ["写一个 Python 函数，把列表按指定大小分块", "Python 里怎么读取一个 CSV 文件并按列求和", "按下回车键没反应怎么办", "Write a SQL query that returns the top 5 customers", "How do I center a div with flexbox?", "Explain big-O notation with an example"]) {
    assert.notEqual(evaluateFastPath(text).recallRecommended, true, text);
  }
});

test("asking whether something was recorded before is an explicit recall", async () => {
  const { evaluateFastPath } = await import("../lib/memory-router/fast-path.js");
  for (const t of ["这个问题我们项目里有没有记录过处理办法", "之前记录过这个坑吗", "did we note this anywhere?", "当初为什么选 SQLite"]) {
    assert.equal(evaluateFastPath(t).reason, "explicit_recall_intent", t);
  }
  assert.equal(evaluateFastPath("记录一下这个坑").reason === "explicit_recall_intent", false);
});

test("a login 'remember me / remember password' feature request is not a remember-this request", () => {
  for (const text of ["增加一个记住密码的", "登录页加个记住我", "勾选记住我", "记住账号功能坏了", "Add a remember me checkbox"]) {
    assert.equal(evaluateFastPath(text).reason, "needs_judgment", text);
  }
  for (const text of ["记住：这个项目的日志统一用 JSON 格式", "你要记住要和openclaw拆开减少耦合", "这个坑记录一下", "把这些规则也要写到agent.md省的之后的修改改错", "把需要长期记忆的写入到obsidian中", "给你定一条规则你不能改openclaw安装包", "你看这些有需要沉淀成长期记忆的吗"]) {
    assert.equal(evaluateFastPath(text).reason, "explicit_remember_intent", text);
  }
});

test("'do you remember' and asking whether something was recorded are recall; earlier code states and 'continue' are left to Laya", () => {
  for (const text of ["Windows 换行那个问题的修法还记得吗", "都写到长期记忆了吗", "Remind me which env vars staging needs", "How did we fix the flaky test?"]) {
    assert.equal(evaluateFastPath(text).reason, "explicit_recall_intent", text);
  }
  // These usually depend on the current conversation or on git history, not on long-term memory.
  for (const text of ["还是改成之前的猫", "撤销上次的提交", "你可以去看之前的代码实现", "按照原来框架的风格统一命名", "继续做你未完成的验证", "继续没做完的", "删除 30 天之前的日志", "继续"]) {
    assert.equal(evaluateFastPath(text).reason, "needs_judgment", text);
  }
});

test("isGenericQuestion flags general knowledge, writing and assistant questions but not questions about our work", async () => {
  const { isGenericQuestion } = await import("../lib/memory-router/fast-path.js");
  for (const text of ["Node 里 existsSync 和 lstatSync 有什么区别", "Python sqlite3 的事务默认是自动提交吗", "What is a git tag vs a GitHub release?", "How do I parse ISO dates?", "写一篇关于灯塔历史的短文", "用 200 字介绍一下茶叶的历史", "你现在的版本是什么", "你可以生成图片吗", "看看明天厦门天气如何"]) {
    assert.equal(isGenericQuestion(text), true, text);
  }
  for (const text of ["我们这个项目里时间统一用什么时区存", "Remind me how we handle broken symlinks", "wx 的 tag 什么时候打", "给 README 加一段安装说明，风格和其他章节保持一致", "What was the reason we dropped GraphQL?", "", null]) {
    assert.equal(isGenericQuestion(text), false, String(text));
  }
});

test("sending the agent to the knowledge base is recall; asking to keep something in agent.md / long-term memory is capture", () => {
  for (const text of ["你可以去obsidian中验证一下再重新设计", "通过obsidian去查找现在已有的资料", "结合vault看看这些记录", "Check the vault for this"]) {
    assert.equal(evaluateFastPath(text).reason, text.startsWith("Check") ? "needs_judgment" : "explicit_recall_intent", text);
  }
  assert.equal(evaluateFastPath("那现在obsidian-memory-plugin这个插件修复了吗").reason, "needs_judgment");
  for (const text of ["那帮我记忆吧", "这个要长期记忆，省的我每次叫你安装", "看看要不要把这个记录放到agent.md中"]) {
    assert.equal(evaluateFastPath(text).reason, "explicit_remember_intent", text);
  }
});

test("looksLikeDurableStatement: rules and personal facts, never questions", async () => {
  const { looksLikeDurableStatement: f } = await import("../lib/memory-router/fast-path.js");
  for (const t of ["以后这个项目的 commit message 都用中文写", "我对花生过敏", "我的减脂目标是每天摄入1800大卡", "我们项目统一用 pnpm，别再用 npm", "我们约定：README 只写中文", "from now on use tabs"]) assert.equal(f(t), true, t);
  for (const t of ["我们约定的是什么？", "以后都用什么？", "怎么统一用 pnpm", "帮我修一下这个 bug", "别再用 npm 了吗", "统一一下格式吧"]) assert.equal(f(t), false, t);
});

test("save requests win over recall rules, more phrasings are caught, and questions, quotes and code are not saves", () => {
  const both = evaluateFastPath("记住，我们约定以后都用 pnpm");
  assert.equal(both.reason, "explicit_remember_intent", "the save keeps its end-of-turn check");
  assert.equal(both.alsoRecall, true);
  for (const text of ["你记得以后提交前先跑测试", "记录下来：部署前要先备份", "以后记得先 lstat 再删", "Remember that the API is rate limited", "don't forget to bump the version", "记一下这个坑：怎么都连不上，原因是代理", "能帮我记住这个吗"]) {
    assert.equal(evaluateFastPath(text).reason, "explicit_remember_intent", text);
  }
  for (const text of ["你记得上次那个方案吗", "写进记忆了吗", "你还记得我们约定的吗？"]) {
    assert.equal(evaluateFastPath(text).reason, "explicit_recall_intent", text);
  }
  for (const text of ["Store this value in a variable", "Record this video at 1080p", "有哪些踩坑点？", "他说\"记住我的密码\"是什么意思", "> 记住：这是引用\n帮我看看这段话", "看看这段代码 `// 记住：先初始化` 有没有问题"]) {
    assert.equal(evaluateFastPath(text).reason, "needs_judgment", text);
  }
});

test("host-internal messages are skipped and never treated as the user's words", () => {
  for (const text of ["__openclaw_memory_core_short_term_promotion_dream__", "[cron:e838772c cyber-health-nightly-review] 执行每日晚间复盘", "[OpenClaw cron wake]"]) {
    assert.equal(evaluateFastPath(text).reason, "system_message", text);
  }
  assert.equal(evaluateFastPath("__init__.py 为什么没被导入").reason, "needs_judgment", "a dunder file name in a question is the user's words");
});

test("a save request is looked for only at the start and end of a long message; Codex's suggestion task is a system message", () => {
  const filler = "Some pasted documentation line about the build.\n".repeat(40);
  assert.equal(evaluateFastPath(`${filler}Remember that Codex can do both knowledge work and software engineering.\n${filler}`).reason, "needs_judgment");
  assert.equal(evaluateFastPath(`记住：发布前先跑 doctor\n${filler}`).reason, "explicit_remember_intent", "a request at the start of a long message still counts");
  assert.equal(evaluateFastPath(`${filler}以上是日志，记住这个坑`).reason, "explicit_remember_intent", "and at the end");
  assert.equal(evaluateFastPath("# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex").reason, "system_message");
});
