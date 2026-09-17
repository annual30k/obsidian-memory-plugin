# Obsidian Memory Plugin

独立、可复用的 Obsidian 长期记忆插件。本文档只说明本插件自身的宿主接入、规则与排障；应用产品可以选择集成它，但不拥有或复制它。

将已有的 **obsidian-memory Skill 内置到 OpenClaw、Codex 与 Hermes 插件**。
插件负责加载入口与元数据配置；当前 Agent 按内置 Skill 建设与维护自生长知识库。

## 包含与依赖

```text
宿主 (OpenClaw / Codex / Hermes)
  → 本插件内置 obsidian-memory Skill
  → 宿主独立安装的完整 kepano/obsidian-skills 套件（按任务加载）
  → 受限的 Vault 文件系统读写（默认）
  → Obsidian CLI → Obsidian 应用（仅应用专属操作）
```

当前包版本：`0.4.2`。本包仅包含一个 Skill：`skills/obsidian-memory/`，
及其流程参考和 14 个最小记忆模板。
**不打包、不复制、不重写 obsidian-skills。**

需要宿主安装完整的 [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)
套件，不只安装 CLI 和 Markdown 两个技能。2026-09-04 核对的上游清单为：

| 技能 | 用途 |
| --- | --- |
| obsidian-cli | 操作正在运行的 Obsidian 应用及其专属能力 |
| obsidian-markdown | 编辑 Obsidian Markdown 笔记 |
| obsidian-bases | 创建和维护 Bases |
| json-canvas | 创建和维护 Canvas |
| defuddle | 提取网页正文为干净的 Markdown |

安装/更新时核对所选上游版本的完整清单，后续新增技能也纳入安装范围，
不把当前五个名称当成永久上限。**安装整套，使用时按任务加载**，不在每轮
对话把所有 Skill 全文塞入上下文，也不自动创建用户未要求的 Base/Canvas。

Agent 会检查整套技能的实际来源与可用性；
已安装但不可见/被禁用/条件不满足时先排查，不重复安装。确认缺失后再
提示依赖，并按宿主安装流程补齐（需要相应授权），检查可见后再继续。
只补齐套件内缺失项，保留现有安装；套件外无关技能不在安装范围内。
插件代码不会静默下载安装。技能文件已安装与其所需 CLI 可用分别验证，
例如 Defuddle 技能存在不代表 Defuddle 可执行工具已配置。

保留的核心规则：

- 默认不记录日常执行，只选择性暂存值得长期保留的 Inbox 候选。
- “记住”只到 Inbox；用户要求 ingest/整理后才冻结为 Raw 并融合进 Wiki。
- 更新已有规范页、标记冲突、维护来源、互链、index 和 append-only log。
- 私有项目隔离；敏感资料需显式保留授权；不保存密码/Token 等凭据值。
- 先判断范围；Global 偏好无需代码目录，不受默认 projectId 强制覆盖。
- 候选 ID、Raw 路径和 ingest 日志标记稳定；中断后检查已有产物再续做。
- 优先兼容已有 Vault 模板；缺失时用内置模板，不自动迁移或覆盖旧库。

不含 MCP、数据库、模型调用、后台记录、独立 I/O 引擎，也不占用 OpenClaw
的 memory 插槽。原始参考目录 `Obsidian Memory Skill/` 未修改。

## 开源与贡献

本项目以 [MIT License](LICENSE) 公开发布，欢迎下载、使用、修改和分发；请保留
版权与许可证声明。`package.json` 中的 `private: true` 仅用于防止误发布到 npm，
不影响 GitHub 仓库的公开可见性或从源码安装。

提交问题或改动前请阅读 [贡献指南](CONTRIBUTING.md) 和
[安全策略](SECURITY.md)。

## 运行条件

- OpenClaw 原生插件接口；首版以 2026.8.2 的 manifest/Hook 接口为基线。
- Agent 的执行环境可访问用户明确选择的 Vault 物理目录；普通 Inbox、Raw、
  Wiki、index 和 log 操作不要求 Obsidian 已启动。
- 只有打开/聚焦笔记、活动视图、Bases、Canvas、反向链接或其他应用专属操作
  才要求 CLI 已启用且 Obsidian 正在运行。CLI 不可用时，这些操作会报告不可用，
  不会阻断普通记忆读写。
- 仅用于受信任单用户 Agent。agentId 限制的是规则注入，**不是权限沙箱**；
  不应将拥有私有 Vault 权限的 Agent 无限制暴露给群聊/陌生用户。
- 读取的资料可能发送到宿主配置的模型服务；本地存储不等于本地模型处理。

## 从 GitHub 获取

任何人都可以克隆公开仓库：

```sh
git clone https://github.com/annual30k/obsidian-memory-plugin.git
cd obsidian-memory-plugin
```

然后按下方 OpenClaw、Codex 或 Hermes 的接入说明配置宿主。若只需下载源码，
克隆完成即可；`package.json` 的 `private: true` 仅阻止误发布到 npm。

## 本地安装

本包没有发布到 npm/ClawHub。可从 [GitHub Release](https://github.com/annual30k/obsidian-memory-plugin/releases)
下载对应版本的 `.tgz` 和 `SHA256SUMS`，校验后从压缩包安装；开发者也可替换下面的绝对路径链接源码：

```sh
shasum -a 256 -c SHA256SUMS
openclaw plugins install ./obsidian-memory-plugin-0.4.2.tgz
```

下例是从源码目录安装：

```sh
openclaw plugins install --link "/absolute/path/to/obsidian-memory-plugin"
```

安装后运行一次配置向导，明确提供已经存在、可读取的 Vault 路径并选择要启用的 Agent
（交互模式默认 `main`）。脚本会保留其他 Agent 和插件设置，验证配置后使用 OpenClaw
自身的配置命令更新本插件条目；不会猜测 Vault，也不会自动创建它：

```sh
npm run setup:openclaw
```

非交互模式必须明确给出 Vault 和 Agent。先用 `--dry-run` 预检，确认后移除该参数：

```sh
npm run setup:openclaw -- --vault "/absolute/path/to/My Vault" --agent main --dry-run
npm run setup:openclaw -- --vault "/absolute/path/to/My Vault" --agent main --yes
openclaw gateway restart
```

如果从 Release 压缩包安装，配置脚本也在安装后的插件目录 `scripts/setup-openclaw.mjs`
内；可运行该脚本（或解压压缩包后在包目录运行以上 `npm run` 命令）。

安装前审核来源。如果宿主要求来源确认，先确认路径及同名旧插件；
不要直接用强制覆盖绕过检查。

宿主侧的 Obsidian 技能套件按上游支持的流程独立安装。例如上游提供：

```sh
npx skills add https://github.com/kepano/obsidian-skills
```

在安装流程中选择实际目标宿主和**全部上游技能**；也可使用宿主自己的
技能安装器补齐完整清单。不要覆盖已有定制版本或写入错误宿主目录。之后
逐个检查来源、可见性和运行条件；只发现 CLI/Markdown 两项不能算全套就绪。

也可手动将 [examples/openclaw.config.json](examples/openclaw.config.json) **合并**
进当前 OpenClaw 配置，不替换其他设置：

```json
{
  "plugins": {
    "entries": {
      "obsidian-memory-plugin": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        },
        "config": {
          "agentId": "main",
          "vault": "My Vault",
          "vaultPath": "/absolute/path/to/My Vault"
        }
      }
    }
  }
}
```

配置：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| agentId | 是 | 启用记忆工作流的 OpenClaw Agent ID |
| vault | 否 | Vault 显示名；仅 CLI 或用户可读提示需要时使用 |
| vaultPath | 是 | Vault 根目录绝对路径；所有记忆文件操作以它为边界 |
| cliPath | 否 | 默认 obsidian；仅应用专属操作需要 CLI 时使用 |
| projectId | 否 | Vault projects.yaml 中已有项目 ID |
| projectRoot | 否 | 用户实际代码目录，不是 Gateway 目录 |

没有项目配置时，Agent 会使用用户当前明确的项目；无法确定则询问，不猜测。
连接检查、初始化和跨项目 Global 偏好不要求项目配置，也不会顺带绑定项目。
空配置可安装但不注入连接。插件不会在注册/Hook 中读取或写入 Vault。

从 `0.4.1` 起，OpenClaw 每轮注入的规则只保留记忆触发条件、Skill 入口、
Inbox/ingest 边界和所选 Vault 配置。完整的依赖检查、作用域与安全流程在
`obsidian-memory` Skill 中按需加载；普通聊天不会因规则注入而访问 Vault。
从 `0.4.2` 起，明确相关的待整理 Inbox 候选也可被找回，但必须标注“待整理”，
不能被当作已确认的 Wiki 知识，召回也不会自动执行 ingest。

如果已有 plugins.allow，保留原成员并加入 `obsidian-memory-plugin`；
检查技能可见性/同名覆盖后重启或重载实际 Gateway，使其载入配置。
外部 Hook 的权限位于 hooks 下，不是 config 下。

## Codex 接入

本包遵循 Codex 原生插件规范，在根目录内置 `.codex-plugin/plugin.json`，与 OpenClaw 共享同一份自生长记忆 Skill。

发布后，应由本仓库的独立 Codex Marketplace 提供安装入口；不要再通过任何应用产品的 Marketplace 分发该通用插件。开发阶段可使用指向本仓库的本地 Marketplace 验证安装与升级。

### 一次性启用全部 Codex 代码项目

安装后的首次配置会要求用户明确提供 Vault 的绝对路径，再安全地更新用户全局
生效中的 Codex 全局 AGENTS 文件：通常是 `~/.codex/AGENTS.md`；若存在非空的
`~/.codex/AGENTS.override.md`，则写入该文件。它只新增或替换自己的标记区块，不覆盖其他指令，也不会
猜测当前打开的 Obsidian Vault：

```sh
npm run setup:codex
```

也可用于非交互自动化；`--yes` 仅在明确提供 `--vault` 时可用：

```sh
npm run setup:codex -- --vault "/absolute/path/to/My Vault" --yes
```

配置完成后，脚本会写入以下规则和所选 Vault 路径（路径作为配置数据，而非指令）：

```markdown
<!-- obsidian-memory-plugin:start -->
For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.
<!-- obsidian-memory-plugin:end -->
```

这让所有新 Codex 代码项目主动加载 memory workflow；它仍只选择性保存长期有价值的信息，
不会自动记录每次聊天或每个 commit。若只希望某个仓库启用，请把同一规则放在该仓库根目录的
`AGENTS.md`，不要运行全局配置脚本。

### 使用环境变量或手动配置

若不使用首次配置脚本，Codex 也可通过环境变量或用户明确选择提供 Vault 连接。在终端或 shell profile（如 `~/.zshrc`）中配置：

```sh
export OBSIDIAN_MEMORY_VAULT="/absolute/path/to/My Vault"
```

并在用户全局生效中的 `~/.codex/AGENTS.md` / `~/.codex/AGENTS.override.md`
（或工作区 `AGENTS.md`）中确认包含引导：

```markdown
For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.
```

### 插件规范校验

```sh
npm run check:codex
```

该检查随本包提供，只依赖 Node.js；不依赖本机的 Codex 私有目录、Python 或
额外的 Python 包。

## Hermes 接入

本包现在包含 Hermes 原生插件。它注册一个**缓存安全、每个新会话仅生成一次**的系统提示词区块，
规则只占很小的固定上下文；完整 Skill 和 Vault 检索仍按需加载。因此不会每轮扫描 Vault 或加载
整份 `SKILL.md`。

Hermes 的插件默认需要显式启用。安装并启用后，运行一次配置脚本；脚本会要求用户提供一个已经存在、
可读取的 Vault 绝对路径，并且只调用 Hermes 配置命令写入本插件自己的 `settings.vault_path`：

```sh
hermes plugins install annual30k/obsidian-memory-plugin
hermes plugins enable obsidian-memory-plugin
node scripts/setup-hermes.mjs
```

非交互环境必须明确给出路径：

```sh
node scripts/setup-hermes.mjs --vault "/absolute/path/to/My Vault" --yes
```

插件不会猜测或创建 Vault，也不会在注册时读写 Vault。它把下面的主动规则放入**新的** Hermes 会话，
然后由 Agent 按需加载命名空间 Skill `obsidian-memory-plugin:obsidian-memory`：

```text
For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.
```

要让本机已安装但较旧的 Hermes 支持这项能力，需要升级到同时提供
`register_skill()` 和 `register_system_prompt_section()` 的版本；适配层会检测缺失能力并拒绝假装已启用。
配置变更也只对新会话生效。可用 `hermes plugins list`、`hermes prompt-size` 和 `hermes config show`
确认状态；不要用全局 `AGENTS.md` 代替这个原生适配层。

## 首次使用

在配置的 Agent 中说：

1. “检查 Obsidian Memory 连接及完整 obsidian-skills 套件；有缺失就提示我补齐整套。”
2. “初始化这个 Vault 的自生长知识库，并绑定项目 /absolute/path/to/project。”
3. “记住：这个项目需要保留离线导出能力。”
4. 在新会话问“你记得离线导出的要求吗？”；此时应只显示“待整理”候选，而不是已确认知识。
5. “整理刚才那条候选记忆。”
6. 再问“这个项目对导出能力有什么要求？”；此时应从 Wiki/Raw 回答并保留来源。

第 3 步只应生成 Inbox，第 5 步才更新 Raw/Wiki。以上演示用合成约束；
不要把它当作真实项目要求自动写入现有库。

只说“检查知识库”时不应改文件；Vault 路径不可访问或所需写入失败时不能回答
“已经保存”。CLI 不可用只影响需要 Obsidian 应用的操作。

## 验证和排障

```sh
npm run check
npm test
npm pack
node tests/openclaw-smoke.mjs obsidian-memory-plugin-0.4.2.tgz
node tests/host-package-smoke.mjs obsidian-memory-plugin-0.4.2.tgz
openclaw plugins inspect obsidian-memory-plugin --runtime --json
openclaw skills --agent main info obsidian-memory
openclaw skills --agent main info obsidian-cli
openclaw skills --agent main info obsidian-markdown
openclaw skills --agent main info obsidian-bases
openclaw skills --agent main info json-canvas
openclaw skills --agent main info defuddle
```

- 只有本包的代码/文件验证不等于真实记忆闭环成功。
- 单元验证覆盖配置、Hook、引用可达性和模板字段契约。隔离 smoke 验证
  tarball 在 OpenClaw 中加载，并逐文件对比其内置 Skill、参考和模板；
  不连接真实 Vault。真实对话用例见源码中的 `tests/skill-scenarios.md`。
- Plugin Skill 可能被同名全局/工作区版本覆盖，检查实际加载来源，不删除别人的技能。
- 外部技能缺失：核对完整上游清单，补齐所有缺失成员；不要只安装当前操作
  会调用的两个技能，也不要固定假设安装目录。任何一项不可用都应在全套
  检查中报告，但不必阻塞与其无关且已验证可用的操作。
- CLI 找不到：普通 Markdown 记忆仍可在已验证的 `vaultPath` 下继续；需要应用
  功能时再检查 Gateway 的 PATH 或设置 cliPath。
- Vault 不匹配：核对物理路径与作用域，不能回退活动窗口或跟随越界符号链接。
- Hook 不生效：检查 agentId、插件启用/允许列表、Hook 权限和实际 Gateway 是否重载。
- 同一项目串行 ingest，不承诺多文件事务或多 Agent 并发写保护。

升级只更新插件文件，不自动改 Vault 模板或历史记忆。已有候选/Raw 的路径
和链接保持不变；旧数据关联不明确时先报告，不换 ID 制造重复 Raw。
已有同名宿主 Skill 可能覆盖插件版，升级后也要核对实际加载来源。

## 禁用与卸载

```sh
openclaw plugins disable obsidian-memory-plugin
openclaw plugins uninstall obsidian-memory-plugin
```

不删除 Vault，不删除宿主独立安装的 obsidian-skills，不修改其他记忆插件。
本项目以 MIT License 公开发布；来源与第三方依赖说明见 [SOURCES.md](SOURCES.md)。

接口参考：[OpenClaw Skills](https://docs.openclaw.ai/tools/skills)、
[Plugin hooks](https://docs.openclaw.ai/plugins/hooks)、
[Obsidian CLI](https://help.obsidian.md/cli)。
