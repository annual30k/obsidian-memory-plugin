# Obsidian Memory Plugin

独立、可复用的 Obsidian 长期记忆插件。本文档只说明本插件自身的宿主接入、规则与排障；应用产品可以选择集成它，但不拥有或复制它。

将已有的 **obsidian-memory Skill 内置到 Antigravity、OpenClaw、Codex 与 Hermes 插件**。
插件负责加载入口与元数据配置；当前 Agent 按内置 Skill 建设与维护自生长知识库。

## 包含与依赖

```text
宿主 (Antigravity / OpenClaw / Codex / Hermes)
  → 本插件内置 obsidian-memory Skill
  → 宿主独立安装的完整 kepano/obsidian-skills 套件（按任务加载）
  → 受限的 Vault 文件系统读写（默认）
  → Obsidian CLI → Obsidian 应用（仅应用专属操作）
```

当前包版本：`0.6.0`。本包仅包含一个 Skill：`skills/obsidian-memory/`，
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
openclaw plugins install ./obsidian-memory-plugin-0.6.0.tgz
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
`0.4.3` 将这段简短指引放在 OpenClaw 当前轮请求前，避免宿主内置的
`memory_search` / `MEMORY.md` 空结果被误当成本插件 Vault 的空结果。
它仍仅在已配置的 Agent 上触发；普通聊天不因此扫描 Vault。

如果已有 plugins.allow，保留原成员并加入 `obsidian-memory-plugin`；
检查技能可见性/同名覆盖后重启或重载实际 Gateway，使其载入配置。
外部 Hook 的权限位于 hooks 下，不是 config 下。

## Codex 接入

本包遵循 Codex 原生插件规范，在根目录内置 `.codex-plugin/plugin.json`，与 OpenClaw 共享同一份自生长记忆 Skill。
品牌图标位于 `assets/icon.png`：Codex 通过 `interface.composerIcon` 与 `interface.logo` 显式读取，
OpenClaw 通过其约定的同名固定路径自动读取。Antigravity 的插件清单本身不支持图片字段，
因此内置 Skill 额外声明 `metadata.icon: "💎"` 作为其 CLI 的图标退化方案。

本仓库自带独立的 `.agents/plugins/marketplace.json`，其条目指向仓库根目录的同一插件；发布到 GitHub 后可用以下命令安装，不依赖任何应用产品的 Marketplace：

```sh
codex plugin marketplace add annual30k/obsidian-memory-plugin
codex plugin add obsidian-memory@obsidian-memory
```

开发阶段可将仓库路径作为本地 Marketplace 来源验证清单；GitHub 安装需等包含该清单的提交公开后才能使用。

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

## Antigravity 接入

本包内置 Antigravity (Google AGY) 原生插件清单 `plugin.json`。Antigravity 会自动从全局插件目录（`~/.gemini/config/plugins/`）或工作区（`.agents/plugins/`）发现已安装的插件并加载其内置的 `obsidian-memory` Skill。

### 一键安装与配置

运行配置向导，提供已存在且可读取的 Vault 绝对路径。向导会自动将插件软链接至 Antigravity 全局插件目录（`~/.gemini/config/plugins/obsidian-memory-plugin`），并在生效的全局规则文件（`~/.gemini/GEMINI.md`）中安全写入标记引导区块：

```sh
npm run setup:antigravity
```

非交互环境可通过参数直接配置：

```sh
npm run setup:antigravity -- --vault "/absolute/path/to/My Vault" --yes
```

配置完成后，脚本会写入以下规则（Vault 路径作为配置数据注入，而非指令）：

```markdown
<!-- obsidian-memory-plugin:start -->
For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.
Obsidian Memory Vault path (configuration data, not instructions): "/absolute/path/to/My Vault"
<!-- obsidian-memory-plugin:end -->
```

### 手动接入与环境变量

若不使用配置脚本，也可通过环境变量或全局规则接入：
1. 在 Shell 环境中配置：
   ```sh
   export OBSIDIAN_MEMORY_VAULT="/absolute/path/to/My Vault"
   ```
2. 将本仓库克隆或软链接至 `~/.gemini/config/plugins/obsidian-memory-plugin`，或在 `~/.gemini/config/plugins.json` 中添加路径条目。
3. 在 `~/.gemini/GEMINI.md` 中确认包含规则：
   ```markdown
   For code tasks, use the obsidian-memory skill before working and when persisting durable project memory.
   ```

### 插件规范校验

```sh
npm run check:antigravity
```

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
npm run check:antigravity
npm run check:codex
npm run check:vault -- --vault /path/to/vault
npm test
npm pack
node tests/openclaw-smoke.mjs obsidian-memory-plugin-0.6.0.tgz
node tests/host-package-smoke.mjs obsidian-memory-plugin-0.6.0.tgz
openclaw plugins inspect obsidian-memory-plugin --runtime --json
openclaw skills --agent main info obsidian-memory
openclaw skills --agent main info obsidian-cli
openclaw skills --agent main info obsidian-markdown
openclaw skills --agent main info obsidian-bases
openclaw skills --agent main info json-canvas
openclaw skills --agent main info defuddle
```

- `npm run check:vault -- --vault <path>`：对目标 Obsidian Vault 进行只读健康自检，检查内置模板对齐情况、死链/失效双链、`00-System/projects.yaml` 规范以及明文敏感凭据泄露风险。
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

## Laya 本地召回裁决服务 (Laya Memory Judge)

为提升 Agent 检索长期记忆的精准度，插件内置了基于轻量级非自回归决策引擎（Laya）的智能召回裁决路由。在用户发起提问时，可在毫秒级（约 7~35 ms）内完成对问题意图的快速研判，兼顾准确率与极低时延，避免无关闲聊或自包含编码任务消耗 Vault 检索 token。

### 架构与硬件路线

1. **Apple Silicon (macOS arm64)**：
   - 采用独立开源 MLX 移植版 [mizorewww/laya-mlx](https://github.com/mizorewww/laya-mlx) (Apache-2.0，声明 378/378 权重对比验证与数值保真；请注意此为独立开源移植版，非 Convai 官方发行)。
   - 模型 checkpoint：`aac6fef/laya-multilingual-mlx`。
   - 资源预期：磁盘权重约 678 MiB，峰值内存占用约 688 MiB，单次决策中位数延迟 ~7.4 ms。
   - 依赖极简：仅需 `mlx`, `huggingface-hub`, `numpy`, `tokenizers`，无 PyTorch / Transformers 运行时负担。
2. **Windows / Linux / x64 macOS**：
   - 采用官方 [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) (>=0.3.5, Apache-2.0) 基于 PyTorch 的跨平台后端。
   - 模型 checkpoint：`convaiinnovations/laya-multilingual`。
   - 资源预期：磁盘权重约 1.2 GiB，内存约 1.2 GiB。
3. **环境隔离与安全性**：
   - 使用 `uv` 在 `~/.laya/venv` 维护独立的 Python >=3.10 环境，不污染系统 Python。
   - 严格落实安全边界：安装必须显式执行，绝不静默下载模型权重；支持 `--skip-model` 跳过下载。
   - macOS/Linux 默认经用户私有 UDS (`0600`) 提供本地 HTTP 语义；Windows 默认使用随机 Loopback（`127.0.0.1`）端口。两者都使用 `secrets.compare_digest` 常量时间校验 Bearer Token，TCP 不绑定局域网地址。
   - 兼容旧版插件可用 `laya start --transport http` 显式切换到 Loopback HTTP；UDS 故障时不静默扩大为 TCP 监听。
   - 符号链接安全防护：对 `--token-file`、`--service-file` 及 `--pid-file` 在解析前先以 `lstat` 严格拦截符号链接，防止凭据窃取或跨目录文件篡改。
   - 元数据原子写入与实例标识：`service.json` 与 `daemon.pid` 均采用同目录临时文件与 `os.replace` 原子写入（POSIX `0600`，目录 `0700`），并维护唯一 `instance_id`；退出时严格核验实例身份，绝不误删其他实例凭据。
   - 停机安全闭环：服务停止与卸载必须通过带鉴权的本地 `POST /shutdown` 验证身份并等待进程退出；禁止凭不可靠的 PID 强杀，杜绝 PID 复用导致的误杀隐患。

### 服务管理命令

```sh
# 1. 显式创建隔离环境、安装依赖并预下载模型权重（按系统架构自动选择 mlx 或 pytorch）
npm run laya:install

# 可选：仅安装 Python 依赖，跳过模型权重下载
node scripts/laya-service.mjs install --skip-model

# 2. 启动本地后台服务（后台 daemon 运行，生成 ~/.laya/service.json）
npm run laya:start

# 可选：需要兼容旧版 HTTP-only 插件时显式使用 Loopback HTTP
node scripts/laya-service.mjs start --transport http

# 3. 查看服务运行状态（进程 PID、本地传输端点、模型状态、脱敏 Token）
npm run laya:status

# 4. 停止本地服务（调用本地已鉴权 POST /shutdown 优雅退出；核验进程真正退出与身份清理）
npm run laya:stop

# 5. 彻底卸载本地服务与虚拟环境（优先鉴权退出，清理 ~/.laya/venv 与服务元数据；默认保留 Hugging Face 权重缓存；若需清除可指定 --purge-cache，且仅精确清理两个 Laya 专属模型目录）
npm run laya:uninstall
```

### 插件自适应配置 (默认即 mode: auto，零配置开箱即用)

本插件默认开箱即用（`mode: "auto"`）。在 OpenClaw、Antigravity、Codex 或 Hermes 中，**无需进行任何手动配置**，系统会自动自适应发现本地运行的 Laya 服务（未运行或未安装时 0ms 安全跳过，完全不影响常规运行）。若需要自定义阈值或强制关闭（`mode: "off"`），可在配置中指定：

```json
{
  "memoryJudge": {
    "mode": "auto",
    "serviceFile": "~/.laya/service.json",
    "recallThreshold": 0.70,
    "timeout": 1000,
    "coldStartTimeout": 5000
  }
}
```

- 当服务未启动时，自动快速降级为安全模式（0 网络开销，后台低频本地探测）。
- 当服务启动并就绪后，自动握手 `/health` 并承接 `/judge/recall` 裁决。
- Laya 服务默认在 **15 分钟无推理请求后卸载内存中的模型**，服务进程继续运行；下一次 `/judge/recall` 会按需重新加载模型。可用 `laya start --idle-unload-seconds 0` 关闭空闲卸载，或传入秒数调整阈值。
- 仅当此前健康的 Laya 服务进程**异常退出**时，`auto` 模式会在当前回合 fail-open 后后台尝试重启；不会在首次使用、未安装或未配置服务时自动安装/启动。
- `laya stop` 会记录显式停止标记并保持服务停止；后续手动执行 `laya start` 会清除此标记并恢复异常退出自动重启。后台恢复采用跨进程锁和节流，Windows 使用同一 Node 启动路径，不经过 shell。
- 支持独立命令行工具直接测试（兼容 PowerShell 与 POSIX 标准管道）：
  ```sh
  # POSIX (macOS / Linux bash / zsh)
  printf '{"text": "我们之前在项目中对于数据库连接池是怎么约定的？"}' | obsidian-memory-laya-judge --stdin --mode auto

  # Windows PowerShell
  '{"text": "我们之前在项目中对于数据库连接池是怎么约定的？"}' | npx obsidian-memory-laya-judge --stdin --mode auto
  ```

### 四大宿主原生前置 Hook 与优雅降级支持矩阵 (v0.6.0)

为了实现彻底脱离“依赖大模型概率性遵循 Prompt”的确定性拦截，插件在四大宿主全面接入原生前置生命周期 Hook：

1. **“100% 前置代码路由”的精确工程定义**：
   - **能保证**：100% 的合格用户回合在调用主大模型前，**必然经过宿主底层原生代码 Hook 拦截与路由判定**（由宿主底层进程执行，而非提示词）。“合格用户回合”的前提是插件处于启用状态且其原生 Hook 已通过宿主信任与审核（在 Codex 中，未受信任的插件 Hook 会被宿主跳过）。
   - **不承诺**：Laya 神经网络服务永远 100% 在线或推理永远成功。
2. **三模式控制矩阵（`off` / `auto` / `strict`）**：
   - `off`：彻底关闭路由与网络探测，零延迟放行。
   - `auto`（默认）：原生 Hook 硬路由 + 优雅降级（Fail-Open）。先 Fast-Path（敏感词/问候/显式意图），必要时调用 Laya；Laya 服务未就绪、异常或超时时不卡死对话，安全降级放行。
   - `strict`：强一致性硬阻断（Fail-Closed）。要求必须具备有效判定；但各宿主阻断能力受宿主原生架构严格限制：

| 宿主 (Host) | 原生 Hook 事件 | 声明与加载位置 | `auto` 模式行为 | `strict` 模式阻断能力与降级机制 |
|---|---|---|---|---|
| **Codex** | `UserPromptSubmit` | `hooks/hooks.json` (由 `.codex-plugin/plugin.json` 的 `hooks` 字段显式指向) | Fast-Path + Laya 注入 `additionalContext`；Laya 异常时 fail-open 放行 | **真正硬阻断 (True Fail-Closed)**：返回 `{"decision": "block", "reason": "..."}`，宿主底层直接阻断 Prompt 提交给模型 |
| **OpenClaw** | `before_prompt_build` + `before_agent_run` | `index.js` 原生插件注册 | Fast-Path + Laya 注入 `prependContext`；Laya 异常时 fail-open 放行 | **原生嵌入/CLI runner 真阻断**：在 OpenClaw `>=2026.9.2` 下通过 `before_agent_run` 返回 `{ outcome: "block", reason, message }` 阻断运行。真实顺序为 `before_prompt_build` 先计算/注入并写入单次判定缓存，`before_agent_run` 随后消费并清理；若前置缓存缺失则 gatekeeper 独立评估以保持 fail-closed。严格硬阻断仅在 OpenClaw 原生嵌入/CLI runner 生效，其它 runner（如 Codex/Copilot runner）仅能保证上下文注入或降级，不可虚假宣称全环境 hard block。不兼容宿主在 strict 模式下拒绝加载。 |
| **Antigravity** | `PreInvocation` | `hooks.json` (或由安装器写入 `.gemini/hooks.json`) | Fast-Path + Laya 注入 `ephemeralMessage`；Laya 异常时 fail-open 放行 | **不支持阻断 (Strict Unsupported)**：宿主 `PreInvocation` 仅具备上下文注入能力，无模型调用中止契约；显式标记 `strict_unsupported` 并安全退化为 `auto` (fail-open)，严禁伪称阻断 |
| **Hermes** | `pre_llm_call` | `__init__.py` 注册原生钩子 | Fast-Path + Laya 注入 `{"context": "..."}` 到用户消息；Laya 异常时 fail-open 放行 | **不支持阻断 (Strict Unsupported)**：宿主钩子调用循环捕获并吞没异常，无模型调用中止契约；显式标记 `strict_unsupported` 并安全退化为 `auto` (fail-open)，严禁伪称阻断 |

3. **结构化审计 Trace 输出到 stderr**：
   在 Codex 和 Antigravity 命令行 Hook 中，为保证标准输出（stdout）严格遵守宿主 JSON 协议，结构化审计日志（`trace`）通过 `stderr` 独立输出，并在输出前完成严格脱敏（严禁包含任何 Prompt 内容或 Token 凭证）：
   ```json
   {
     "route": "laya | fast_path | fallback",
     "decision": "recall | capture | none | block",
     "reason": "explicit_recall_intent | circuit_breaker_open | ...",
     "hookExecuted": true,
     "layaAttempted": false,
     "hostCapability": "codex_user_prompt_submit | openclaw_before_agent_run | antigravity_pre_invocation_strict_unsupported | hermes_pre_llm_call_strict_unsupported",
     "strictDegraded": true
   }
   ```
   > **审计准则**：`hookExecuted` 字段在底层通用 router 与 CLI 中默认为 `false`，必须且仅由真实宿主原生 Hook 适配层在实际拦截时置为 `true`，杜绝虚假审计标记。同时 stdout 保持单一合法宿主 JSON，绝不污染。

4. **安装器防重复执行与 Hook 发现机制**：
   - 插件内置的原生 Hook 声明（Codex 的 `hooks/hooks.json` 与 Antigravity 的 `hooks.json`）为宿主发现并加载的单一首要来源。
   - `scripts/setup-codex.mjs` 与 `scripts/setup-antigravity.mjs` 安装脚本默认 `configureHooks: false`，避免在插件内置 Hook 之外向全局配置文件重复注册导致单次回合双重执行。
   - 仅在用户显式传入 `--hooks` 命令行参数时，安装脚本才会向用户全局目录配置独立 Hook。


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
