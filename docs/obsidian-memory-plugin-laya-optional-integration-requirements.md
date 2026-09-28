# Obsidian Memory Plugin — Laya 可选智能判断服务集成需求说明书

## 1. 文档信息

- **项目名称**：obsidian-memory-plugin
- **功能名称**：Laya Optional Memory Judge Integration
- **目标版本**：v0.7.x（召回判断、Vault 检索、主动写入与会话整理、本地 IPC）
- **文档用途**：指导 OpenClaw / Antigravity / Codex / Hermes 跨宿主适配与验收
- **核心定位**：Laya 为可选的本地智能判断与检索加速器，不是插件的必选依赖；插件遵循"单一 Skill 核心 + 多宿主原生适配"架构
- **实现状态（2026-09-27）**：本文最初是 2026-09-23 的开发需求稿，现已按当前代码更新。已落地：原生宿主 Hook、默认 `mode: auto`、跨宿主严格模式降级、模型空闲卸载与按需重载、崩溃恢复、Capture / Relation Judge、本地 IPC，以及之后新增的训练式召回分类头、Vault 语义检索器、长期规则判断头、显式"记住"的回合结束兜底、异步会话整理（自动暂存进 inbox）、本机文件统一放在 `~/.laya`、`mode: off` 零副作用。以第 4 节的状态勾选和第 4.9 节的未验证清单为准。
- **发布状态**：上述功能已在作者本机四个宿主安装试运行；版本号仍为 0.7.0，尚未提交与发布。

---

## 2. 项目背景与设计哲学

当前 `obsidian-memory-plugin` 已建立了一套基于物理 Obsidian Vault 的长期记忆工作流（Global / Project 作用域隔离、Inbox 候选区、Raw 原始证据、Wiki 沉淀、Decision / Pitfall / Knowledge 分类、Recall、Ingest 与 Log）。

在原有架构中，是否需要检索历史、属于哪个作用域、是否值得记下来，都依赖宿主 Agent / 主 LLM 遵守 `obsidian-memory` Skill 规则完成。实测表明这有两个问题：

1. **读得太多**：常驻规则要求"代码任务先用 Skill"，约三分之一的回合都会读 17 KB 的 SKILL.md 并搜索 Vault，而真实提问里真正需要长期记忆的只有约 2%（作者 520 条真实提问中 10 条）。
2. **写得太少**：2026 年 9 月的 583 个真实 Codex 回合里，agent 自发写入 inbox 约 5 次；用户明确说"记住"的 12 次里写了约 8 次。约 46% 的回合结论（根因、决定、规则）本值得保留，但几乎都没进 inbox。

Laya 的核心定位是：

> **本地、低延迟、可插拔的 Memory Router / Judge / Retriever 加速器。**
> 它只参与辅助决策与检索计算，不拥有记忆数据，不直接读写 Vault，也不替代现有安全与生命周期规范。

### 核心设计原则

1. **可选与解耦（Optional Acceleration）**：用户未安装 Laya、Laya 未启动、崩溃或超时，插件功能均完整可用，无缝退回原生逻辑。
2. **基础安全 Guidance 永不剔除**：Laya 绝不能决定是否向 Agent 注入安全前言与连接配置。连接元数据（Vault 路径、作用域隔离、只写 Inbox 边界）是安全底线；唯一的例外是 Laya 高置信"本轮不需要记忆"时，OpenClaw 用一段精简块替换完整工作流文字，连接元数据仍然保留。
3. **确定性策略优先（Deterministic Policy > Laya）**：用户显式指令（"记住这个"、"查上次方案"）或硬性排除（敏感 Token、纯打招呼）直接走确定性短路（Fast-Path），不向 Laya 发起推理请求。
4. **判断与检索分开**：只看单句文本的模型答不了"要不要查记忆"中依赖 Vault 内容的那部分。召回由两路信号共同决定：Laya 的记忆需求分（训练式分类头）回答"这句话像不像在问过去"，检索器回答"Vault 里有没有一篇笔记明显对应这句话"。
5. **写入分两条路**：用户显式要求保存时在回合内同步完成并兜底；其余自动暂存一律在回合外异步进行，不让用户等，不额外调用大模型，硬规则由代码执行而不是靠模型读完 Skill。
6. **宿主能力差异化（Host Capability Awareness）**：承认异构宿主的物理差异（常驻进程 vs 每轮新进程；有无回合结束控制），不强行把同一种保证套用到所有宿主。
7. **本地隐私与防投毒安全（No Blind Exfiltration）**：严禁在未认证的默认端口上自动盲发用户文本，防止本机恶意进程抢占端口监听私有对话；写入队列前先脱敏。
8. **熔断与优雅降级（Circuit Breaker）**：采用三态熔断器，连续故障即刻切断，避免退化状态下每次对话增加 1 秒卡顿。
9. **`off` 就是没有路由**：`mode: off` 时不调模型、不加提示、不写任何本机文件，行为与接入 Laya 之前一致。
10. **本机文件只有一个家**：插件在本机的所有运行文件都在 `~/.laya`，记忆内容本身始终在 Obsidian Vault。
11. **只认真实流量的评估**：阈值和规则以作者的真实提问与真实回合为准，报告跳过率、误跳过率和写入量，不以合成测试集的 F1 为准；在同一批数据上调出来的指标一律标注为偏乐观。

---

## 3. 宿主能力矩阵与运行模型 (Host Capability Matrix)

| 宿主 | 运行时特性 | 回合前（召回判断与提示） | 回合结束 | Laya 集成形态 |
| :--- | :--- | :--- | :--- | :--- |
| **OpenClaw** | 常驻 Node.js 网关进程 | `before_prompt_build` 注入；strict 时 `before_agent_run` 阻断 | `before_agent_finalize`：显式要求未写入时要求再跑一轮（每回合最多一次）；`agent_end`：把本轮提问与最终回复写入整理队列 | 进程内路由、三态熔断器、`.unref()` 定时发现；这两个回合结束钩子需要配置 `hooks.allowConversationAccess: true` |
| **Codex** | 每轮新起的钩子进程 | `UserPromptSubmit` 注入 `additionalContext`；strict 可 `decision: block` | `Stop`：显式要求未写入时 `decision: block` 一次；把本轮写入整理队列 | 服务状态与熔断状态经 `~/.laya/state/router-state.json` 跨进程复用；**两个钩子来自插件自带的 `hooks/hooks.json`，用户在 Codex 应用插件页"Hooks"一栏点 Trust all（或 `/hooks`）批准一次后才会运行** |
| **Antigravity** | 每轮新起的钩子进程 | `PreInvocation` 注入 `ephemeralMessage` | 无回合结束控制；下一轮开始时从会话记录补记上一轮 | strict 不支持，显式降级为 auto；按"会话 + 回合"去重，每轮只处理一次 |
| **Hermes** | Python 适配器，经 Node CLI 调路由 | `pre_llm_call` 注入 context | `post_llm_call`（观察型）：经 `cli.js --enqueue-turn` 写入整理队列 | strict 因宿主无可靠阻断契约而降级 |

### 3.1 常驻宿主（OpenClaw）
- `before_prompt_build` 先计算并注入指导，再将本轮一次性判定交给 `before_agent_run` strict gate；上下文明确标记为非用户 trigger 时零 Laya 请求。
- 使用常驻内存熔断器与独立状态（`useCache: false`），不与每轮新进程共享状态缓存。
- 进行确定性策略前置检查 → 如需 Laya 则请求 `POST /judge/recall`（顺带取提示向量）→ Vault 语义匹配 → 会话延续 → 生成提示。
- 若在 auto 模式下未发现服务，后台定时器使用 `timer.unref()`；永久协议 / 认证失败停止定时器。
- `mode: off` 时不创建路由，也不注册回合结束钩子。

### 3.2 每轮新进程的宿主（Codex / Antigravity / Hermes）
- 原生 Hook 在模型调用前执行，不依赖 LLM 是否遵循 Skill。服务发现、健康状态（含服务能力列表）和熔断状态通过 `~/.laya/state/router-state.json` 跨进程复用。能力列表必须一并缓存，否则这些进程会误以为服务不支持检索而退回词重叠匹配（已修复的缺陷）。
- 插件随包提供宿主 Hook；安装脚本默认不重复写全局 Hook（`--hooks` 才写，只用于不加载插件钩子的宿主版本）。
- 默认 `mode: "auto"`。Laya 未安装或不可用时 auto fail-open；`mode: "off"` 时零网络请求、零本机文件。
- Codex strict 可在 `UserPromptSubmit` 阻断；Antigravity、Hermes 不提供可靠阻断契约，strict 显式降级。
- Antigravity 没有回合结束钩子：上一轮在下一轮开始时补记，一次会话的最后一轮要等用户再回到该会话才会进入队列。

---

## 4. 版本迭代范围与状态

### 4.1 v0.6.x（首个 MVP）
- [x] Laya HTTP Client、协议校验与 Open Schema
- [x] 宿主能力矩阵适配（OpenClaw 运行时拦截及 Codex / Antigravity / Hermes 原生 Hook）
- [x] 确定性策略前置短路（Fast-Path Filter）
- [x] 本地防投毒与可信 Endpoint 发现（严格 Loopback 校验）
- [x] 三态熔断器（CLOSED / OPEN / HALF_OPEN）
- [x] Recall Judge 闭环与 Prompt Guidance 动态增强
- [x] 冷启动超时治理、模型首次推理加载、空闲卸载与下一次请求重载
- [x] 插件配置白名单重构（放行并校验 `memoryJudge`）
- [x] Laya 服务异常退出后后台恢复：仅在服务此前健康、且可确认进程已死亡时尝试；首次使用 / 未安装不自动启动；跨进程锁与节流
- [x] 显式 `laya stop` 后保持停止，再次 `laya start` 才恢复自动拉起

### 4.2 v0.7.x（当前实现）
- [x] Capture Judge API 与 CLI（只作第二意见，见 4.5）
- [x] Relation Judge API（只作建议，见 4.6）
- [x] POSIX Unix Domain Socket；Windows 自动使用 loopback HTTP（见 4.7）
- [x] 训练式召回分类头：在 Laya 句向量 + 零样本分数上训练的逻辑回归，用户可用 `laya label` / `laya train` 以自己的真实提问重训（见 4.3）
- [x] Vault 检索器：服务内置 `intfloat/multilingual-e5-small`（纯 MLX 实现，无额外 Python 依赖），按"突出度"判断 Vault 是否有明显对应的笔记，并把笔记路径写进提示（见 4.3）
- [x] 服务能力列表写入跨进程缓存，修复每轮新进程宿主上检索器从未生效的缺陷
- [x] 项目解析兼容软链接路径（macOS `/var` → `/private/var`、软链接的项目目录）
- [x] 长期规则判断头：识别"以后……都……"一类的长期规则陈述（见 4.4）
- [x] 显式"记住"的回合结束兜底：OpenClaw / Codex 在 inbox 没有新文件时要求再跑一轮，每回合最多一次；Antigravity / Hermes 下一轮提醒一次（见 4.4）
- [x] 异步会话整理（`autoCapture: "digest"`，默认）：回合结束只入队，会话空闲后后台按会话合并、按话题取最后结论，写入 inbox（见 4.4）
- [x] 回合内补跑（`autoCapture: "revise"`）与下一轮提醒（`"remind"`）保留为可选模式
- [x] 本机文件统一放在 `~/.laya`，旧位置自动迁移（见 4.8）
- [x] `mode: off` 零副作用：不写任何本机文件、不入队、不整理（见 5.1）

### 4.3 召回判断详细设计：分类头 + Vault 检索器

**每轮流程**（`lib/memory-router/router.js`、`turn-context.js`、`vault-index.js`）：

1. Fast-Path（见第 6 节）：命中即决定，不调用模型。
2. 记忆需求分：`POST /judge/recall`。服务先问零样本三选一问题（需要项目历史 / 自成一体的请求 / 闲聊），再用训练式分类头给出校准后的分数，使默认阈值 0.35 / 0.50 正好落在分类头选出的工作点上。只有分数 ≥ 0.35 时才追加第二次模型调用询问作用域与类别，自成一体的回合只花一次推理。
3. 通用知识问题（"X 和 Y 有什么区别""写一篇……""你的版本是什么"等）即使分数偏高也不触发召回，也不做 Vault 匹配。
4. Vault 语义匹配：同一次 `/judge/recall` 带 `embed: true` 取回本轮提示的单位向量；插件为 Vault 的 `10-Global` 与各项目 `wiki/`、`inbox/` 笔记建索引（标题、aliases、tags、代码标识符加正文前 600 字），通过 `POST /embed` 算笔记向量并缓存（每轮最多补 32 篇，笔记改动后只重算该篇）。
   - **突出度** = 最相关笔记的余弦相似度 − 候选笔记相似度中位数。绝对相似度分不开（同一项目的任务与笔记本来就都相似），突出度问的是"有没有一篇特别对得上"。
   - 强匹配（≥ 0.048）：改为"先查记忆"，即使分数说不需要；弱匹配（≥ 0.038）：本轮不跳过。两种情况都附上最相关的 1–3 篇笔记路径。
   - 候选笔记限于当前项目与 Global，除非提示点名了别的项目；候选少于 5 篇时不做语义判断。
   - 检索器不可用（PyTorch 后端、旧服务、`laya start --embed-model off`、`vaultSemantic: false`）时退回词重叠匹配（中文二字词、英文单词，IDF 加权），只补拿不准的回合。
5. 会话延续：上一轮刚调取过记忆、这一轮拿不准时沿用；"继续""那这个呢"之类的短追问不跳过。
6. 输出：分数 ≥ 0.50 或强匹配 → *先查记忆*；分数 < 0.35 且无匹配 → *不需要记忆*；其余或 Laya 不可用 → 不加提示。

**为什么检索器是单独的模型**：Laya 自身的平均池化句向量做检索接近随机（AUC 0.39～0.57，top-1 塌缩到同一篇笔记），e5-small 的 top-1 命中率好，但绝对相似度仍分不开负例，改用突出度后才分开。

**实测**（作者 Vault，501 条真实无关提示 + 66 条针对 Vault 内容的提问）：只用分类头时误跳过 5%、召回 86%；加上突出度后误跳过 0%、召回 98%，无关提示仍有 83% 被跳过。端到端在 511 条真实提示上误跳过从 3 次降到 1 次，Vault 提问集召回从 24/27 提到 26/27，代价是多出 10 条"先查记忆"提示（多为模拟器、部署类任务，Vault 里确有对应笔记）。

**省下多少**：在 2026-08-26 以来 732 个真实 Codex 回合上反事实估算，读 SKILL.md 的次数减少 52%（240 → 115），与记忆相关的耗时从每回合 10.1 秒降到 5.3 秒（−47%）；路由日志里 12 个真实"跳过"回合，agent 一次都没读 Skill。

**分类头训练**：`laya label` 逐条标注本机积累的真实提问（y 先查记忆 / c 要求保存 / d 陈述长期规则 / n 不需要 / x 单句判断不了），`laya train` 用分层交叉验证训练并自动重启服务。加载顺序：`LAYA_RECALL_HEAD` → `~/.laya/recall-head.json` → 插件自带的一份。

### 4.4 主动写入详细设计：显式兜底 + 异步会话整理

**写入权**：回合内只有 Skill 的规则能决定写入；回合外的自动暂存由会话整理按同一套硬规则在代码里执行。所有候选都是 `status: pending-ingest`，入库（ingest）始终由用户发起。

#### 4.4.1 显式要求：回合内，同步
- Fast-Path 识别"记住……""记一下这个坑""写到 agent.md""沉淀成长期记忆"等（排除"记住密码 / 记住登录"这类登录功能用语）→ 提示 *用户要求保存*，agent 按 Skill 在本轮结束前写 inbox 候选。
- **兜底**：路由记下目标 inbox 目录的签名；回合结束时（OpenClaw `before_agent_finalize` 返回 `revise`，Codex `Stop` 返回 `decision: block`）若没有新文件，要求模型再跑一轮补上。每个回合最多一次，和回合结束检查共用这一次；宿主传 `stop_hook_active` 时不触发。
- 解析不到项目时，签名覆盖 Global 与所有项目的 inbox，写进任何一个都算已写入；指令里不指定 Global，由 Skill 判断范围。
- Antigravity / Hermes 没有回合结束控制：下一轮提示里提醒一次。

#### 4.4.2 自动暂存：回合外，异步（`autoCapture: "digest"`，默认）

```text
回合结束（Codex Stop · OpenClaw agent_end · Hermes post_llm_call · Antigravity 下一轮开始时）
   │  提问 + 最终回复（≥ 200 字，脱敏），毫秒级，不调模型
   ▼
~/.laya/capture-queue/<会话>.jsonl   ←  提问时：长期规则陈述、排错后"好了"的确认
   │  会话空闲 20 分钟：后台等待进程（全机一个，--wait）或下一个钩子拉起（同时只跑一个）
   ▼
scripts/memory-digest.mjs（或 laya digest --now）
   │  选结论 → 按话题合并 → 每个话题取最后一轮 → 代码执行硬规则
   ▼
Vault 项目 inbox/cand-<uuid>.md（origin: auto-digest，pending-ingest）
```

1. **入队**（`lib/memory-router/capture-queue.js`）：每个会话一个私有 JSONL 文件（目录 0700、文件 0600）。只收最终回复 ≥ 200 字的回合，提问截断到 1500 字、回复截断到 4000 字，写入前把凭据替换为 `[REDACTED]` 并标记。单个队列文件超过 2 MB 后不再追加。
2. **选结论**（`lib/memory-router/digest.js`）：最终回复有 ≥ 2 个结论词（根因 / 原因： / 修法 / 已修复 / 规则 / 约定 / 决定 / 改为 / 不再 / 尚未 / 下一步……），或 Laya capture 分 ≥ 0.5（只在结论词不够时才请求），或之后被用户确认"好了 / 可以了"的回合。
3. **按话题合并，只取最后一轮**：有检索器时按回复的语义相似度分话题（余弦 ≥ 0.91 视为同一话题，在手写结论对上校准，未用真实数据），没有检索器时整个会话算一个话题。确认过的话题优先，其次是轮数多、时间近的。每个会话最多 2 个话题候选，外加最多 2 条用户长期规则陈述。
4. **硬规则在代码里执行**：
   - Vault 已初始化（有 `AGENTS.md` 与 `00-System/`），否则跳过；
   - 项目已解析（宿主配置的 `projectId`，或按 `00-System/projects.yaml` 的 roots 从工作目录解析），且 `20-Projects/<项目>/` 与其 `inbox/` 已存在；不创建项目结构，不猜范围；项目内容永远不写进 Global，只有带"全局 / 跨项目"字样的用户陈述进 `10-Global/inbox/`；
   - Vault 或项目的 `AGENTS.md` / `rules.md` 中有 `no-auto-capture`（或"禁止自动记录""只召回"等）就不写；
   - 含凭据的回合整条不写；
   - 优先使用 Vault 自己的 `00-System/templates/inbox-memory-candidate.md`，没有才用插件自带模板；
   - 文件名 `cand-<uuid>.md`，独占创建，物理路径不得逃出 Vault；
   - 同一会话的同一结论不写第二次；同样文字的结论在该 inbox 已有候选（`source_hash`）不写；与已有 auto-digest 候选余弦 ≥ 0.95 视为重复；显式"记住"的回合 agent 已写过候选时不写。
   - 写文件前对成稿再扫一遍凭据（sk- / sk-proj- / sk-ant- / sk_live_ / xoxb- / AIza / hf_ / glpat- / 带密码的 URL / JSON 里的 apiKey / "密码是……" 等），命中不写。
5. **候选内容是原话证据**：本轮提问原文 + 最后一轮结论原文（引用），注明该话题共几轮、是否被用户确认，标 `origin: auto-digest`、来源宿主与会话，附检索器找到的相关笔记。归纳提炼留到用户发起 ingest 时。
6. **收尾**：处理完删除该会话的队列文件，结果写入 `~/.laya/digest-log.jsonl`（出错也记）；Vault 暂时读不到或出错时保留队列下次再试；超过 7 天的队列先整理，整理不了才删除并记日志。下一轮提示告诉用户暂存了几条（每批一次），`npm run doctor` 显示积压与上次整理。

**为什么按会话、取最后一轮**：9 月的真实数据中，有触发的 48 个会话平均触发 5.5 次，89% 的触发落在触发 ≥ 3 次的会话里；36 个多次触发的会话里有 12 个后来改口（"更正""之前判断不对""其实是"）。逐回合记录会对同一件事写多条，并记下中途被推翻的结论。

**长期规则陈述**（`durable-head.json`）：在 Laya 句向量 + 零样本分数上训练的逻辑回归，判断用户这句话是不是以后也要遵守的规则、偏好、决定或环境事实。作者 520 条真实提示上（79 条标为长期规则，标注由 Claude 完成）折外精确率约 0.55～0.6、召回约 0.4。`digest` 模式下命中的陈述进入队列，不再当场提示模型；没有训练头时不产生这类信号。用 `laya label` 的 `d` 积累标注，`npm run laya:train -- --target durable` 重训。

#### 4.4.3 其他模式

| 模式 | 回合内等待 | 额外大模型调用 | 说明 |
|---|---|---|---|
| `digest`（默认） | 钩子约 85～150 毫秒 | 无 | 上述异步整理 |
| `revise` | 触发时 4～66 秒，平均每回合约 15～20 秒 | 约 45% 的回合一次 | 回合结束检查：最终回复 ≥ 200 字且结论词 ≥ 2 或 Laya capture 分 ≥ 0.5 时，OpenClaw / Codex 要求模型再跑一轮按 Skill 暂存；指令明确覆盖本轮早先的"不需要记忆"提示 |
| `remind` | 无 | 无 | 同样的检查只在下一轮提示一次 |
| `off` | 无 | 无 | 只保留显式要求 |

同一个修 bug 任务在隔离环境里用真实 Codex 实测：`revise` 整轮 108 秒（其中补跑 66 秒，读 SKILL.md 与两份参考文档约 31 秒，真正写内容约 24 秒）；`digest` 整轮 46 秒，`Stop` 钩子约 85 毫秒，事后整理 157 毫秒，写出的候选内容准确。`revise` 的回合结束检查在 583 个真实回合上触发 45%（约每天 11 次）；在 110 个由 Claude 标注的回合上精确率 0.69、召回 0.71，但门槛就是在这批数据上调出来的，偏乐观。

`proactiveCapture: false` 关闭全部主动写入信号，包括显式要求的保存提示与回合结束兜底；此时用户说"记住"，由 agent 按常驻规则与 Skill 自行处理。按分类在每轮主动建议写入的旧机制已移除：在 735 条未见过的真实提示上它触发 40 次、0 次正确；配置里的 `layaCapture` 保留为无效兼容项。

### 4.5 Capture Judge 详细设计（CLI，第二意见）

**目标**：判断一段已完成工作的总结是否值得进入 Inbox，并给出建议分类 / 作用域。Capture Judge 不决定最终保存，不创建文件，不更新既有 Wiki，也不改变用户显式的记忆要求。

**当前角色**：
- 回合内：agent 可以调用 `obsidian-memory-laya-judge --capture --stdin`，但只能针对已经通过 Skill 两条相关性测试的候选作为第二意见；它说"不"、低置信或出错都按不采集处理，它从不单独触发写入。
- 会话整理中：`POST /judge/capture` 只用来补救结论词不够的回复（capture 分 ≥ 0.5 即算作有结论）。

**输入合同**（UTF-8 JSON 从 stdin 传输，避免把文本放入命令行）：

```json
{"text":"经验证的任务结论摘要，不超过 2048 字符","projectId":"optional-project-hint"}
```

- 仅提交完成任务所必需的结论摘要；禁止原始 transcript、整页 Vault 内容、凭据 / Token、个人敏感数据。CLI 另有凭据格式屏蔽，命中则不发送。
- 输入超限、空白、JSON 格式错误、Judge 不可用或输出不可信时，按不采集处理；不得阻塞主任务。

**输出与策略**：JSON 固定字段 `task=capture`、`recommended`、`score`、`confidence`、`category`（`pitfall | decision | knowledge`）、`scope`（`project | global | unknown`）；不输出自由文本、不回显输入。`score >= captureThreshold`（默认 0.75）且 `confidence >= 0.60` 才为 `recommended`。不缓存输入 / 输出文本。

### 4.6 Relation Judge 详细设计

**触发流程**：Agent 在正常 Recall 或 ingest 中选出一个候选记忆和一个可能相关的存量记忆后，可调用 `obsidian-memory-laya-judge --relation --stdin`。Relation Judge 不自行搜索 Vault，也不接收 Vault 路径或文件句柄。

**输入合同**：

```json
{"candidate":"候选记忆的最小必要摘录，<=2048 字符","existing":"存量记忆的最小必要摘录，<=2048 字符"}
```

两段文本都按不可信数据处理；空值、越界、不可用或校验失败时返回 `unrelated`，不影响 Agent 正常工作。

| 标签 | 含义 | 后续动作 |
|---|---|---|
| `support` | 候选为存量记忆提供独立支持 / 证据 | 可在候选中记录来源；不自动改写存量 |
| `extension` | 语义兼容但包含非重复的新细节 | 人工判断是否补充或另建候选 |
| `duplicate` | 两者核心耐久信息基本相同 | Agent 可避免重复建条目；不得自动删除 |
| `conflict` | 相互矛盾且不能证明哪个取代哪个 | 保留两边证据并提示用户核对 |
| `supersession` | 新证据明确取代旧决定 / 事实 | 先建立新候选和 supersedes 链接；不自动归档旧条目 |
| `unrelated` | 无有意义关联、证据不足或 Judge 不确定 | 继续独立处理 |

响应只含 `relation` 固定枚举和 `confidence`；不输出原因、不回显摘录、不执行任何 Vault 写入。

### 4.7 本地 IPC 详细设计（POSIX UDS / Windows loopback HTTP）

- 同一 HTTP 语义与 Bearer token 校验应用于全部接口；IPC 只是传输替换，不更改业务 API、Fast-Path、熔断与 fail-open 语义。
- macOS / Linux：默认使用 `~/.laya/service.sock`，socket 文件权限 `0600`、父目录 `0700`；拒绝既存 symlink / 非 socket 路径，只回收 service 文件能证明属于已退出 PID 的陈旧 socket，退出时按 inode / device 身份删除本实例创建的 socket。`service.json` 保留 API 版本、PID、实例 ID、token 与 transport 元数据。
- 多宿主共享同一个用户级服务：服务在创建监听器和写入登记文件之前，必须持有同目录 `.service.instance.lock` 的操作系统独占锁直到退出（POSIX `flock`，Windows `msvcrt.locking`）；第二个并发服务必须退出且不得覆盖已有元数据。
- Windows：采用随机 loopback TCP 端口 + Bearer token，不绑定局域网地址，按用户 Profile 目录包含性校验 `service.json`；不虚构 POSIX `0600` 等价权限。Named Pipe 不作为 v0.7 必要条件。
- `laya start --transport http` 可显式为旧版插件启用 loopback HTTP；默认 `auto` 在 POSIX 选 UDS、Windows 选 HTTP。UDS 失败时不自动改连 HTTP。
- 单次请求载荷上限 64 KB（`/embed` 为 256 KB），推理串行执行，排队超过 1 秒返回 503。

### 4.8 本机文件布局

插件在本机只用一个文件夹 `~/.laya`（与 Laya 服务共用；`LAYA_HOME` 改它的上级目录，与 `laya` 命令一致；`OBSIDIAN_MEMORY_LAYA_DIR` 直接指定该文件夹，供测试与迁移）。所有路径只由 `lib/memory-router/paths.js` 给出，新增文件不得放到别处。记忆内容本身（inbox、raw、wiki）始终在 Obsidian Vault。

| 位置 | 内容 | 能不能删 |
|---|---|---|
| `service.json` `service.sock` `daemon.pid` `venv/` | Laya 服务 | 用 `laya stop` / `laya uninstall` |
| `recall-head.json` `durable-head.json` | 用户标注训练的判断头 | 删了回到插件自带的 |
| `labels*.jsonl` `testsets/` | 标注 | 用户数据 |
| `decisions.jsonl` | 每轮判断日志（0600，超过 5 MB 轮转，含密钥的提示不记原文） | 可以；`decisionLog: false` 关闭 |
| `digest-log.jsonl` | 会话整理写了什么、跳过了什么 | 可以 |
| `capture-queue/` | 等待整理的回合 | 删了这些回合就不整理了 |
| `state/` | 会话状态、服务健康缓存 `router-state.json`、整理记录与锁、Antigravity 回合记录 | 可以，会重建 |
| `cache/` | Vault 索引与笔记向量 | 可以，会重建 |
| `backups/` | 安装与迁移时的备份 | 可以 |

**迁移**：旧版本放在 `~/.cache/obsidian-memory-plugin`（Windows 为 `%LOCALAPPDATA%\obsidian-memory-plugin`）的文件，以及系统临时目录里的 `antigravity-turn-*.json`，在插件第一次运行时自动搬进 `~/.laya`；不覆盖较新的文件（较旧的状态副本丢弃，日志追加合并），不动不认识的文件，旧文件夹清空后才删除。测试进程固定写到自己的临时目录，不触发迁移。

### 4.9 未验证项与后续

- OpenClaw `agent_end` / `before_agent_finalize` 与 Hermes `post_llm_call` 只经过单元测试和钩子层冒烟，尚未在真实网关的真实对话中跑过；真实端到端只在隔离环境里用 Codex 验证过。
- Codex 的两个钩子需要用户批准一次（插件页 Trust all 或 `/hooks`）；批准前 Codex 回合没有记忆提示、不进入整理队列。
- 自动候选在真实使用中的保留率（用户整理时留下多少）没有数据，是决定默认模式是否合适的关键指标。
- 话题合并阈值 0.91 只在手写的结论对上校准过（2026-09-28），未用真实会话；结论词表与 200 字门槛在同一批数据上调出，偏乐观；标注由 Claude 完成，口径不是用户本人的。
- 2026-09-27 审计：新代码上线后四个宿主都没有真实用户回合经过这些路径；OpenClaw `agent_end` 曾把 cron 失败重试重放的旧回复入队（已修复：只收用户回合、不回找历史、按问答去重）；整理此前从未运行（已加后台等待进程）；脱敏漏掉 9 种常见密钥格式（已补齐并在写入前复查）；小项目语义匹配几乎总判强、空项目串到其他项目（已改为小范围以全库为参照、按项目限定候选）。修复后仍需在每个宿主上各做一次真实对话验收。
- 长期规则判断头在 `digest` 模式下 ≥ 0.5 入队（折外 P≈0.53 / R≈0.47），另有确定性说法兜底；但作者的真实长期规则多夹在任务请求里（"整个 app 的字体大小要统一风格……"），确定性说法在 520 条真实提问上命中 0 条，主要靠判断头。
- 2026-09-28 发现：9-24 为支持 `hermes plugins install` 给根 `plugin.json` 加了 Agent Plugins `$schema` 之后，Codex（0.155 起）改按 Agent Plugins 清单读取根清单，而 Codex 读这种清单时不读钩子（顶层 `hooks`、数组写法、`extensions["com.openai"].hooks` 均无效），插件钩子从此不运行、插件页也不显示待批准的钩子。已去掉 `$schema`，Codex 回到读取 `.codex-plugin/plugin.json`；代价是 Hermes 改用 `git clone` + `hermes plugins enable` 安装。若 Codex 将来支持 Agent Plugins 清单里的钩子，可恢复 `$schema`。
- Windows 上的新功能（`~/.laya` 路径、后台整理进程）未经实机验证。

---

## 5. 安全体系与防本地投毒设计

在本地多进程环境中，开放未认证的固定 HTTP 端口存在**用户 Prompt 文本泄露**的严重隐私风险。系统必须遵循以下安全规范：

### 5.1 激活与授权模式
配置项 `memoryJudge.mode` 支持：
- `auto`（默认）：只通过本地受信 `service.json` 或显式配置的 loopback endpoint 连接；不可用时 fail-open。Laya 未安装或未启动时，不依赖模型的部分照常运行（Vault 词重叠提示、会话延续、判断日志、整理队列与按结论词筛选的会话整理），文件在 `~/.laya`。
- `off`：**等于没有路由**。不调模型、不探测服务、不加每轮提示，也不写任何本机文件（没有会话状态、Vault 索引、判断日志、整理队列，不做会话整理、不记 Antigravity 回合）。只剩常驻规则与 Skill，由 agent 自己判断；用户说"记住"时 agent 照样按 Skill 写 Obsidian inbox，只是没有回合结束的兜底。`off` 不停止 Laya 服务进程，需要释放内存时运行 `laya stop`。
- `manual`：显式指定受信任的 loopback endpoint；不会因环境变量隐式回退。
- `strict`：Laya 不可用时阻断本轮；只有 Codex 与 OpenClaw（官方 embedded / CLI runner）真正支持，其他宿主显式降级为 auto。

### 5.2 受信发现原则（Anti-Spoofing）
禁止对公共端口做无校验的"盲连 + 盲发文本"：
1. **显式配置优先**：用户在配置中显式写入 `endpoint`，视为用户主动信任（`mode: manual` 必须显式提供，不从环境变量隐式回退）。
2. **安全服务发现文件**：读取 `~/.laya/service.json`（Windows 默认 `%USERPROFILE%\.laya\service.json`）：
   - POSIX：文件属主必须为当前用户；含 `token` 时**必须严格为 `0600` 权限**。
   - Windows：采用严格的 User Profile 目录包含性检查（按路径分段边界比较，阻断 `C:\Users\bob-evil` 类前缀绕过）。
   - Token 必须为无控制字符的安全字符串，**绝对禁止输出到日志、CLI 输出或持久状态缓存**。
3. **Loopback 与 SSRF 防御**：显式 HTTP endpoint 严格限定为 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`（禁止 `localhost`、局域网、云元数据地址）；自动发现的 UDS 仅可来自通过属主、权限、同目录、socket 类型校验的 `service.json`；禁止跟随 HTTP 重定向。

### 5.3 写入相关的安全规则
- 整理队列在写入前脱敏；含凭据的回合不产生候选。
- 候选只写进已绑定项目的 inbox 或（明确的跨项目陈述）Global inbox，不创建项目结构、不写 raw / wiki / preferences / checkpoints，不修改或删除已有笔记。
- 提示中的笔记路径是 Vault 相对路径，以 JSON 编码作为"数据"注入，拒绝绝对路径、`..` 与控制字符。
- 提示向量只在路由内部使用，不交给宿主、不写入日志或提示。

---

## 6. 确定性策略与前置短路 (Fast-Path Filter)

Laya 是概率模型，存在计算开销和误判几率。在调用 Laya 之前，必须先经过确定性策略引擎（`lib/memory-router/fast-path.js`）：

```text
               User Input
                   │
                   ▼
     ┌───────────────────────────┐
     │  Deterministic Fast-Path  │
     └─────────────┬─────────────┘
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
  Hit Rule?                Ambiguous
       │                       │
       ▼                       ▼
Direct Native Action      Call Laya Judge
(Skip Laya Call)          (POST /judge/recall, embed)
```

### 6.1 命中即决定的规则
1. **敏感信息拦截**：检测到高置信度 Secret（`password=`、`api_key=`、`sk-…`、GitHub / AWS token、私钥头、JWT、Bearer）→ 跳过，严禁把文本发给任何模型，判断日志不记原文。
2. **日常寒暄**：20 字以内的纯礼貌用语（"你好""谢谢""好的""早安"）→ 不需要记忆。
3. **显式回忆意图** → 先查记忆：
   - "回忆一下 / 查一下……记忆 / 之前……怎么解决 / @memory"；
   - 引用过往约定："照老规矩""和上次一样""延续之前""我们约定的"；
   - 询问是否记过："有没有记录""之前写过吗"；询问当初原因："当时为什么"；
   - "还记得""你记得吗"；明确让 agent 去知识库："去 obsidian 查""结合 vault 看看"（不含插件名 `obsidian-memory`）；
   - 英文："as usual""like last time""what did we decide"等。
   - 不在此判定："改成之前的""撤销上次提交""继续没做完的"——真实标注表明这些多依赖当前对话或 git 历史。
4. **显式踩坑记录**："记录一下这个坑""踩坑""避坑"→ 要求保存（pitfall）。
5. **显式记录意图**："记住……""记一下""写到 agent.md""沉淀成长期记忆""remember this"→ 要求保存；排除"记住密码 / 记住我 / 记住登录状态"。
6. **通用知识问题**（不属于短路，但约束后续）："X 和 Y 有什么区别""默认是多少""写一篇……""你现在的版本""天气"等，且不含"我们 / 这个项目 / 之前"等自指词 → 分数再高也不召回，也不做 Vault 匹配。

---

## 7. 契约与接口设计 (API Specification)

所有 Laya HTTP API 使用 `snake_case`，遵循 **Open Schema** 原则（严格校验必需字段与数值区间，容忍未知扩展字段）。除 `/health` 外均需 Bearer token；`/health` 也要求 token。

### 7.1 服务健康检查：`GET /health`

```json
{
  "service": "laya-memory-judge",
  "status": "ok",
  "api_version": "1",
  "model_status": "ready",
  "idle_unload_seconds": 900,
  "capabilities": ["recall", "capture", "relation", "scope", "warmup", "recall_head", "embed"],
  "embed_model": "intfloat/multilingual-e5-small",
  "embed_status": "ready",
  "backend": "mlx",
  "model": "aac6fef/laya-multilingual-mlx",
  "recall_head": {"path": "~/.laya/recall-head.json", "trained_at": "2026-09-24", "prompts": 731},
  "durable_head": {"path": "~/.laya/durable-head.json", "trained_at": "2026-09-24", "prompts": 533},
  "instance_id": "…"
}
```

- `status`：`"ok"` 或 `"degraded"`；`api_version`：`"1"`。
- `model_status` / `embed_status`：`"ready" | "loading" | "unloaded"`。
- `capabilities` 必须包含 `"recall"`；`embed` 表示检索器可用，`recall_head` 表示已加载训练式分类头。
- 客户端把 `capabilities` 连同健康状态写入 `~/.laya/state/router-state.json`，供每轮新进程复用；能力未知时仍请求提示向量（旧服务会忽略该字段）。

### 7.2 召回判断：`POST /judge/recall`

请求：

```json
{
  "text": "之前处理 OpenClaw gateway 超时问题是怎么配置的？",
  "project_context": {"project_id": "openclaw-a1b2c3d4"},
  "embed": true
}
```

- `text`（必需）：当前轮次用户输入，最大 2048 字符。
- `project_context`（可选）：只传项目标识符。
- `embed`（可选）：为 `true` 且服务有检索器时，响应附带本轮提示的单位向量。

响应：

```json
{
  "requires_memory": 0.94,
  "confidence": 0.92,
  "category_confidence": 0.81,
  "scope": {"project": 0.88, "global": 0.08, "unknown": 0.04},
  "categories": {"pitfall": 0.85, "decision": 0.60, "knowledge": 0.30},
  "zero_shot": 0.71,
  "recall_head": true,
  "durable_statement": 0.12,
  "durable_head": true,
  "query_embedding": [0.0213, -0.0441, "… 384 维"],
  "embed_model": "intfloat/multilingual-e5-small"
}
```

- `requires_memory`（必需）：记忆需求分。加载分类头时为分类头的校准分数（0.35 / 0.50 对应其工作点），否则为零样本分数。
- `confidence`（必需）、`scope`、`categories`：分数 < 0.35 时不做第二次推理，`scope` / `categories` 为 0。
- `zero_shot`、`recall_head`：零样本原始分数与是否使用了分类头。
- `durable_statement` / `durable_head`：长期规则判断头的分数（仅在加载了该判断头时出现）。
- `query_embedding` / `embed_model`：仅在请求 `embed: true` 且检索器可用时出现；客户端校验为有限数值向量（≤ 4096 维），只在路由内部使用。

### 7.3 文本向量：`POST /embed`

请求 `{"texts": ["…"], "kind": "query" | "passage"}`，1～32 条，每条 ≤ 1200 字符，载荷 ≤ 256 KB。响应 `{"model": "…", "dim": 384, "vectors": [[…]]}`，向量已归一化、保留 4 位小数。服务没有检索器时返回 404；e5 系列模型自动加 `query: ` / `passage: ` 前缀。

### 7.4 其他接口
- `POST /warmup`：后台开始加载已卸载的模型（判断模型与检索器），立即返回健康信息与 `warming`。
- `POST /judge/capture`：`{"text"}` → `capture_score`、`confidence`、`category`、`scope`（见 4.5）。
- `POST /judge/relation`：`{"candidate","existing"}` → `relation`、`confidence`（见 4.6）。
- `POST /shutdown`：`{"pid","instance_id"}` 身份匹配后停止服务；`laya stop` / `laya uninstall` 使用。

---

## 8. 三态熔断器 (Circuit Breaker)

为解决"Laya 半死状态导致每一轮对话卡死 1000ms"的问题，采用标准三态熔断器：

```text
               ┌──────────────────────────────┐
               │            CLOSED            │◄────────────────┐
               │    (Normal: Call Laya)       │                 │
               └──────────────┬───────────────┘                 │
                              │ Consecutive Failures >= 2       │
                              ▼                                 │ Trial Success
               ┌──────────────────────────────┐                 │
               │             OPEN             │                 │
               │   (Fallback: Skip Laya)      │                 │
               └──────────────┬───────────────┘                 │
                              │ Reset Timeout (5 min)           │
                              ▼                                 │
               ┌──────────────────────────────┐                 │
               │          HALF_OPEN           │─────────────────┘
               │     (Trial: 1 Request)       │
               └──────────────┬───────────────┘
                              │ Trial Failed
                              ▼
                        (Back to OPEN, 退避加倍，上限 30 分钟)
```

### 8.1 状态转移规则
1. **CLOSED**：所有未被 Fast-Path 拦截的请求正常调用 Laya；连续 `consecutiveFailures`（默认 2）次业务调用异常后切入 OPEN。
2. **OPEN**：立即本地回退，不发起任何 Laya 请求，零等待；持续 `resetTimeout`（默认 5 分钟）。
3. **HALF_OPEN**：允许 1 个试探请求；成功切回 CLOSED，失败回到 OPEN 并把冷却时间加倍（上限 30 分钟）。

### 8.2 错误类型与处理策略
- **临时性故障**（超时、连接被拒、HTTP 5xx、503 繁忙）：计入失败计数。
- **协议不兼容**（`api_version` 不匹配、Schema 严重畸变）：标记为永久故障，持续 OPEN，不再周期试探。
- **认证失败**（401 / 403）：发出安全警告日志，持续 OPEN。
- 检索相关调用（`/embed`、Vault 向量补算）失败只影响本轮的语义匹配，退回词重叠匹配，不计入召回判断的熔断。

---

## 9. 超时治理与 Lazy Load 适配

```json
{
  "timeout": 1000,
  "coldStartTimeout": 7500,
  "coldStart": "background",
  "healthTimeout": 200
}
```

### 9.1 超时分层策略
- **热态**：请求超时 1000 ms。实测单次判断约 7～50 ms（含本机通信），检索器编码一句约 5 ms；每轮新进程宿主的钩子总耗时（含 Node 启动）约 85～150 ms。
- **冷态**（模型因首次使用或空闲卸载处于 `unloaded`）：
  - `coldStart: "background"`（默认）：用一次新鲜的 `/health` 确认状态，调用 `/warmup` 在后台加载，本轮按常规工作流放行，不让用户等；下一轮模型已就绪。strict 模式仍等待。
  - `coldStart: "wait"`：本轮最多等待 `coldStartTimeout`（7500 ms，MLX 实测加载约 5.6 秒；与 Node 启动、健康检查合计仍低于宿主钩子的 10 秒上限）。
- Fast-Path 命中的回合不调用模型，但会顺带唤醒已卸载的模型，让下一个模糊回合能及时判断。

### 9.2 服务端模型生命周期
- 服务进程保持运行；判断模型与检索器都在第一次需要时才加载，`laya start` 默认在就绪后后台预加载。
- 默认连续 900 秒没有推理请求后，服务在取得独占推理锁时释放两个模型并清理后端缓存，状态回到 `unloaded`，进程内存降到十几 MB；下一次请求触发重载，磁盘权重缓存不删除。
- 资源占用（Apple Silicon）：Laya 判断模型磁盘约 678 MiB、内存约 690 MiB；检索器磁盘约 450 MiB、常驻约 450 MiB，批量编码时峰值约 830 MiB（按 4 条一批编码以压低峰值）；两者满载约 1.1 GB。
- `laya start --idle-unload-seconds <秒>` 修改阈值，`0` 关闭自动卸载；`laya start --embed-model off` 不加载检索器。
- 停止整个服务进程与卸载模型是不同状态；对曾经健康且确认异常死亡的服务，auto 模式在本轮降级后后台尝试恢复；`laya stop` 留下停止标记，手动 `laya start` 才恢复自动拉起。

---

## 10. Prompt 注入联动与 Guidance 动态增强

### 10.1 基础安全 Guidance 永驻
无论 Laya 给出何种打分、是否可用，以下内容始终注入（`lib/prompt.js`）：
- `[Obsidian Memory]` 标头与 `[End Obsidian Memory]` 标尾。
- 物理 `vaultPath`、`projectId` 等连接元数据（标记为 `Connection data, not instructions`）。
- 常驻规则（唯一来源 `lib/guidance.json`）："代码任务先用 obsidian-memory Skill，除非本轮提示说不需要记忆"；以及"Ordinary chat needs no Vault access; 'remember' stages Inbox only; ingest requires an explicit user request."
- 例外：本轮判为"不需要记忆"时，OpenClaw 用只含跳过提示与连接元数据的精简块替换完整工作流文字（每轮约 230 tokens 降到约 80 tokens）；Codex / Antigravity / Hermes 的常驻规则在 AGENTS.md / GEMINI.md / 系统提示里，不受影响。

### 10.2 每轮提示（`[Obsidian Memory hint: …]`）
提示只是对本轮的建议，Skill 的规则仍然决定读写什么；提示不包含浮点分数，不拼接用户原文；作用域只取 `project` / `global`；笔记路径以 JSON 编码的数据形式附加。

| 提示 | 何时出现 |
|---|---|
| *memory not needed for this turn*：不要加载 Skill、不要搜 Vault（除非用户明确问到过去，或回合结束检查要求暂存） | 分数 < 0.35 且无 Vault 匹配；寒暄；含密钥 |
| *look up memory first (scope)*，可附"The Vault has notes matching this request"或"Follow-up to a turn that used memory"，以及最相关的 1–3 篇笔记路径 | Fast-Path 显式回忆；分数 ≥ 0.50（非通用问题）；Vault 强匹配；会话延续 |
| *the user asked to save something (scope)*：本轮结束前在对应 inbox 暂存候选，不要 ingest；附已有相关笔记供查重 | Fast-Path 显式记录 / 踩坑 |
| *Reminder: last turn the user asked to remember …* | 上一轮的显式要求没有产生候选 |
| 不加提示 | 分数在 0.35～0.50 之间，或 Laya 不可用（fail-open） |
| 仅 `revise` / `remind` 模式：长期规则检查、踩坑检查、回合结束检查（覆盖本轮早先的"不需要记忆"提示） | 见 4.4.3 |

`digest` 模式下，长期规则陈述与"好了"确认进入整理队列，不再产生当场提示；回合结束也不再要求补跑。

---

## 11. 配置体系与代码兼容性

### 11.1 配置结构声明（OpenClaw；其他宿主见 11.2）

```json
{
  "enabled": true,
  "hooks": {
    "allowConversationAccess": true,
    "allowPromptInjection": true
  },
  "config": {
    "agentConfigs": {
      "main": {"vaultPath": "/Users/user/Obsidian/Workspace", "projectId": "OpenClaw-87012890"}
    },
    "memoryJudge": {
      "mode": "auto",
      "endpoint": null,
      "serviceFile": "/Users/user/.laya/service.json",
      "discoveryInterval": 300000,
      "timeout": 1000,
      "coldStartTimeout": 7500,
      "coldStart": "background",
      "healthTimeout": 200,
      "recallThreshold": 0.5,
      "skipThreshold": 0.35,
      "captureThreshold": 0.75,
      "proactiveCapture": true,
      "autoCapture": "digest",
      "vaultHints": true,
      "vaultSemantic": true,
      "decisionLog": true,
      "consecutiveFailures": 2,
      "resetTimeout": 300000,
      "layaCapture": false
    }
  }
}
```

以上是 `~/.openclaw/openclaw.json` 中 `plugins.entries["obsidian-memory-plugin"]` 的结构：`config` 是插件配置，`hooks` 是 OpenClaw 授予插件的权限（`before_agent_finalize` 与 `agent_end` 需要 `allowConversationAccess`）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto` / `off` / `manual` / `strict`（见 5.1） |
| `recallThreshold` / `skipThreshold` | 0.50 / 0.35 | 先查记忆 / 不需要记忆的分数线；`skipThreshold` 不会超过 `recallThreshold` |
| `captureThreshold` | 0.75 | 长期规则判断头与 Capture Judge 的门槛 |
| `proactiveCapture` | `true` | `false` 关闭全部主动写入信号 |
| `autoCapture` | `digest` | `digest` / `revise` / `remind` / `off`（见 4.4） |
| `vaultHints` / `vaultSemantic` | `true` | Vault 匹配 / 其中的语义检索 |
| `decisionLog` | `true` | 每轮判断日志 `~/.laya/decisions.jsonl` |
| `coldStart` / `coldStartTimeout` | `background` / 7500 | 见第 9 节 |
| `layaCapture` | `false` | 已废弃的兼容项，不起作用 |

> **路径处理说明**：`serviceFile` 统一解析为平台绝对路径（Windows 为 `%USERPROFILE%\.laya\service.json`，POSIX 展开 `~`），禁止把未展开的 `~` 用于文件系统调用。`lib/config.js` 拒绝未知字段；`openclaw.plugin.json` 的 schema 与 `DEFAULT_MEMORY_JUDGE` 由测试保证一致。

### 11.2 各宿主的设置方式与环境变量

| 设置 | OpenClaw | Codex / Antigravity | Hermes |
|---|---|---|---|
| 路由模式 | `memoryJudge.mode` | `OBSIDIAN_MEMORY_JUDGE_MODE` | 插件设置 `memory_router_mode`（或 `OBSIDIAN_MEMORY_ROUTER_MODE`） |
| 自动暂存模式 | `memoryJudge.autoCapture` | `OBSIDIAN_MEMORY_AUTO_CAPTURE` | 插件设置 `auto_capture` |
| Vault 路径 | `agentConfigs.<agent>.vaultPath` | AGENTS.md / GEMINI.md 受管区块，或 `OBSIDIAN_MEMORY_VAULT` | 插件设置 `vault_path` |
| 服务地址 | `memoryJudge.endpoint` / `serviceFile` | `OBSIDIAN_MEMORY_ENDPOINT` / `OBSIDIAN_MEMORY_SERVICE_FILE` | 同左 |

其他：`OBSIDIAN_MEMORY_DECISION_LOG=off` 关闭判断日志；`OBSIDIAN_MEMORY_DIGEST=off` 不在后台拉起会话整理（队列照常写入，可手动 `laya digest`）；`OBSIDIAN_MEMORY_LAYA_DIR` / `LAYA_HOME` 见 4.8；`LAYA_RECALL_HEAD`、`LAYA_DURABLE_HEAD`（设为 `off` 关闭对应判断头）、`LAYA_EMBED_MODEL`（设为 `off` 关闭检索器）作用于服务进程。

### 11.3 代码模块

| 模块 | 职责 |
|---|---|
| `lib/config.js` | 配置解析与校验（四个宿主共用） |
| `lib/prompt.js`、`lib/guidance.json` | 每轮提示文字、常驻规则（唯一来源） |
| `lib/memory-router/fast-path.js` | 确定性短路、脱敏、通用问题识别 |
| `lib/memory-router/router.js` | 服务发现、熔断、冷启动、召回判断、向量与 capture 分的旁路调用；`mode: off` 时不做任何附带处理 |
| `lib/memory-router/vault-index.js` | Vault 索引、词重叠匹配、笔记向量缓存、突出度匹配、项目解析（含软链接） |
| `lib/memory-router/turn-context.js` | 每轮上下文：Vault 提示、会话延续、判断日志、显式要求兜底、回合结束检查、入队 |
| `lib/memory-router/capture-queue.js` | 整理队列 |
| `lib/memory-router/digest.js`、`scripts/memory-digest.mjs` | 会话整理与后台触发 |
| `lib/memory-router/paths.js` | 本机文件位置与一次性迁移 |
| `lib/memory-router/client.js`、`schemas.js`、`security.js`、`cache.js`、`circuit-breaker.js`、`auto-restart.js` | 服务客户端、响应校验、受信发现、跨进程状态、熔断、崩溃恢复 |
| `lib/laya-service/service.py`、`bert_embed.py` | Laya 服务（判断、检索器、capture、relation）；约 150 行的纯 MLX BERT 编码器 |
| `index.js` / `__init__.py` / `scripts/codex-hook.mjs`、`codex-stop-hook.mjs`、`antigravity-hook.mjs` | 四个宿主的适配器 |
| `scripts/laya-service.mjs` | `laya` 命令：install / start / stop / status / uninstall / label / train / digest / doctor / eval / tune / calibrate-vault / bench |

---

## 12. 验收场景与测试矩阵 (Acceptance Criteria)

### 场景 1：完全未安装 Laya 的环境（Zero-Laya Baseline）
- **动作**：全新安装插件，不运行 Laya（默认 `mode: "auto"`），发起对话。
- **预期**：不发送用户文本、不盲探端口；基础 Guidance 完整注入，无延迟卡顿；不依赖模型的功能（词重叠提示、会话延续、整理队列）照常工作，文件只写在 `~/.laya`。

### 场景 2：Laya 运行正常（Happy Path）
- **动作**：启动 Laya 服务，发起含模糊历史意图的提问。
- **预期**：握手通过，熔断器 CLOSED；分数 ≥ 0.50 时追加"先查记忆"提示；业务请求成功本身作为健康依据，不周期性调用 `/health`。

### 场景 3：确定性策略前置短路（Fast-Path）
- **动作**：输入"查一下上次关于 gateway 超时的 pitfall 记录"。
- **预期**：直接判定需要检索，**不向 Laya 发起任何判断请求**。

### 场景 4：模型冷启动（Cold-Start Tolerance）
- **动作**：服务运行但模型处于 `unloaded`，用户发起请求。
- **预期**：默认 `background` 下本轮不等待、按常规工作流放行并后台加载，下一轮正常判断；`wait` 或 strict 下最多等待 7500 ms；均不发生熔断跳闸。

### 场景 5：Laya 进程崩溃与熔断
- **动作**：强制结束 Laya 进程，连续发起对话。
- **预期**：首次失败立即回退并在后台尝试重启已安装的服务；连续失败 2 次跳闸 OPEN，之后毫秒级响应；服务恢复后按身份变化重新握手；`laya stop` 后不自动重启。

### 场景 6：本地 IPC 抢占 / 伪造防御
- **动作**：Windows / HTTP 下第三方进程抢占端口，或 POSIX 下预置 symlink / 普通文件 / 未登记 socket。
- **预期**：HTTP 必须校验 token；UDS 必须经安全 `service.json`、同目录、socket 类型、属主与 `0600` 验证；失败时不向不可信目标发送用户文本。

### 场景 7：Vault 语义匹配
- **动作**：Vault 中已有"安装器遇到失效软链接报 EEXIST"的踩坑笔记，用户问"安装脚本遇到失效的软链接会报 EEXIST，该怎么改"（Laya 分数约 0.34）。
- **预期**：四个宿主都给出"先查记忆"并附上该笔记路径；在每轮新进程的宿主上同样生效（服务能力从缓存恢复）。

### 场景 8：显式"记住"兜底
- **动作**：用户说"记住：这个项目的日志统一用 JSON"，agent 本轮没有写 inbox。
- **预期**：OpenClaw / Codex 在回合结束时要求再跑一轮一次；写入任何一个 inbox 后不再追问；同一回合不会再触发第二次；Antigravity / Hermes 下一轮提醒一次。

### 场景 9：异步会话整理
- **动作**：一次会话中连续几轮排查同一个问题，最后给出根因与修法，然后会话空闲。
- **预期**：回合结束钩子毫秒级返回、不调用模型、不阻塞；空闲 20 分钟后（或 `laya digest --now`）在该项目 inbox 生成 1 条 `origin: auto-digest` 候选，内容为最后一轮结论原文；项目未绑定、Vault 未初始化、项目声明 `no-auto-capture`、含凭据时均不写，也不写进 Global；`--dry-run` 只报告不写。

### 场景 10：`mode: off` 零副作用
- **动作**：设为 `off`，依次触发提问钩子与回合结束钩子。
- **预期**：不调用 Laya、不加每轮提示、`Stop` 钩子不阻塞，`~/.laya` 及服务文件目录下不新增任何文件；显式"记住"仍由 agent 按 Skill 写 Obsidian。

### 场景 11：本机文件布局与迁移
- **动作**：从旧版本升级，旧文件在 `~/.cache/obsidian-memory-plugin` 与系统临时目录。
- **预期**：第一次运行后全部移入 `~/.laya`，旧文件夹清空后删除；不覆盖较新的文件，不动不认识的文件；之后不再在别处创建文件。

### 场景 12：Codex 钩子信任
- **动作**：插件新增 `Stop` 钩子后，用户未在 Codex 中批准。
- **预期**：Codex 提示钩子需要审核，未批准前 `Stop` 钩子不运行，提问钩子照常工作；插件不得代替用户写入信任记录。

---

## 13. 一句话工程铁律

```text
1. 安全底线不退让：基础安全 Guidance 永不丢弃，候选写入前脱敏，凭据绝不落盘。
2. 宿主能力不臆想：区分常驻进程与每轮新进程、有无回合结束控制。
3. 读写权责分明：Recall / Capture / Relation 只给建议；回合内只有 Skill 决定写入，回合外只写 pending 候选且规则由代码执行。
4. 不让用户等：自动暂存在回合外完成，钩子毫秒级返回。
5. off 就是没有：关闭路由即零请求、零提示、零本机文件。
6. 文件只有一个家：运行文件都在 ~/.laya，记忆内容都在 Obsidian Vault。
7. 本地传输不盲信：POSIX UDS 优先，Windows 严守 Loopback 与认证。
8. 容灾熔断不妥协：两次失败即切断，绝不卡死用户。
9. 评估只认真实流量：在同一批数据上调出的指标一律标注偏乐观。
```
