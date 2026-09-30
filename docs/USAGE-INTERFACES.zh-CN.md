# 客户端模型用量检测接口集成文档

> **目的**：把 token-monitor 检测"各 AI 编程工具的模型用量"的全部接口知识集中成一份文档，用于**迁移到其他项目**或**从零开发**同类功能。
> **事实来源**：`src/shared/clientSources.js`、`clientCatalog.js`、`collector.js`（watch 策略）、`tokscaleClientMapping.js`、`docs/providers/*.md`（19 篇）、tokscale fork 扫描器（`crates/tokscale-core/src/sessions/*.rs`）与 CLI `--help` 实测。
> **基线**：v0.63.1 + vendored tokscale fork `token-monitor-ab1067f3`（4.17.0）。2026-09 整理。

---

## 0. 两条集成路线

| | 路线 A：tokscale CLI | 路线 B：自研解析 |
|---|---|---|
| 做法 | 调用外部 `tokscale` 二进制，喂 `--client` 过滤和 `--group-by`，消费 JSON | 自己实现每个客户端的数据文件解析器 |
| 覆盖面 | 50+ 客户端（见 §2.4 能力清单），持续上游维护 | 只覆盖你实现的那些 |
| 成本 | 集成成本低；依赖外部二进制（版本/分发需管理） | 每个客户端都要读源码/逆向数据格式，格式随版本漂移需跟进 |
| 适用 | 想快速得到和 token-monitor 一致的用量数据 | 只关心 1-2 个客户端（如 dsh-all-usage 插件只解析 DSH）、或不能携带外部二进制 |
| token-monitor 的实践 | 主路线（31 个客户端中 29 个走它） | proma、qodercn 两个本地解析适配器 + dsh 会话详情/元数据的本地读取 |

两条路线可以混用：token-monitor 里本地解析客户端的输出会**造出 tokscale 形状的 JSON** 走同一套归一化（`extractUsageFromTokscale`），见 §3.7。

---

## 1. 通用数据模型（两条路线共用的契约）

### 1.1 token 五桶

每次模型调用报告五个桶，**reasoning 是 output 的子集，总处理量 = input + output + cacheRead + cacheWrite + reasoning**：

```
inputTokens          新输入（不含缓存命中）
outputTokens         输出（含 reasoning；不要再把 reasoning 加一次）
cacheReadTokens      缓存读取（复用上下文）
cacheWriteTokens     缓存写入
reasoningTokens      推理 token
```

各客户端的坑（详见 §5 分客户端）：Cline 的 `metrics.inputTokens` 沿上游约定摇摆，`cacheReadTokens > inputTokens` 的行输入可为负（约 3.6% 消息）；Qoder CN 的 JSONL `input_tokens` 已含 cached 前缀（需做减法）；DSH 的 `outputTokens` 原样透传；Kimi 只有 `usageScope: "turn"` 的行计数（`"session"` 是运行时簿记）。

### 1.2 模型与供应商身份

- **模型名**：统一小写归一（`normalizeModelName`）；同一客户端可能出现 requested model 与 served model 两个身份（DSH：请求 `cbai/deepseek-v4.1-flash`，上游实际服务 `deepseek-v4.1-flash`）——**按服务端实际模型归属**更稳定。
- **provider 维度**：tokscale 行对 dsh（网关名：router/router9/kala…）和 opencode（profile 名）携带独立 `provider` 字段。按 `model` 单独聚合会把不同供应商的同一模型合并；要分供应商必须保留这个维度（参考 dsh-all-usage 的结构化身份：`identityKey = [provider, requestedModel, actualModel]`）。
- **特殊模型键**：Cursor 的 `auto`/`default` 归并为 `cursor-auto`（仅限 cursor，防止误并其他客户端）；Devin 的 `adaptive` 是路由值不是模型 id；Qoder CN 有退役内码需要映射。

### 1.3 成本

- 定价来自公开目录（models.dev / litellm / openrouter），按 provider hint（模型 key 内嵌的厂商段，如 `openrouter/google/gemini-3-pro-preview`）选官方条目；未知/自定义/免费模型**显示 0 或"未计价"，不要猜价**（显示 0 ≠ 免费）。
- 自定义单价：tokscale 读 `<configDir>/custom-pricing.json`（含 managed-ids sidecar）。
- 四桶计价（cc-switch 公式）：input、output、cacheRead、cacheWrite 分别乘每百万单价再相加；context-tier 分档按"本次请求输入上下文 > 阈值则整次切换费率"。

### 1.4 增量恒等式（实时更新的核心机制）

会话日志是**只追加**的，因此任意聚合期（today/month/allTime）满足：

```
newAgg = baseAgg + freshToday − anchorToday     （对 union(keys) 递归，数值叶子生效）
```

- 全量扫描串行跑 today/month/allTime（并发三扫会把 CPU/IO 打爆）；watch tick 只扫 `--today`，month/allTime 用上式从锚点推导——**这是恒等式不是估算**。
- 锚点失效条件：跨本地日、配置指纹变化（客户端列表/自定义目录/起点时间）、源数据代际切换。
- "今天"按**本地时区**日界切分（`localDayKey`），周期窗口到期时间随数据上报（供 Hub 侧过期冻结）。

### 1.5 文件形态范式（自研解析时要处理的三大类）

| 形态 | 代表 | 要点 |
|---|---|---|
| **多帧 zstd JSONL** | DSH `session.v3.jsonl.zstd` | 每次 flush 追加一个 zstd frame；必须逐帧定位（扫 frame 头）再解压，直接整文件解压只能拿到第一帧；尾部可能是 torn frame；版本化文件名 `session[.vN].jsonl(.zstd)` 并存 |
| **SQLite（+WAL/SHM）** | hermes state.db、zed threads.db、opencode.db、devin sessions.db | 只读打开（busy_timeout）；WAL/SHM 不是解析输入但是"活跃写"信号（watch 它们）；只读扫描会重写 `*.db-shm` wal-index——自建 watcher 必须丢弃自己导致的 -shm 事件，否则无限自触发 |
| **JSONL / JSON / 日志** | claude projects、amp T-*.json、lmstudio .log | 流式追加去重（消息身份+时间+路由+token 签名）；流式 API 可能对同一调用追加多次 usage（Cherry Studio 每调用追加 3-4 次，需去重）；大文件用有界 head/tail 读 |

### 1.6 Watch 策略要点（若做实时更新）

- 防抖重臂（不排队），无冷却——产品承诺秒级更新；
- 目录过大的客户端必须**白名单裁剪**（如 hermes 只 watch `state.db(+wal/shm)` 三个文件——整目录递归 watch 曾把 CPU 打满 100%，运行时有 15 万+文件）；
- 嵌套根要合并策略（union），bounded 不能吞掉 recursive；
- Windows watch 根必须 realpath（8.3 短路径/junction 会让 libuv abort）；
- 自写缓存目录**绝不 watch**（自写自触发死循环）；
- inotify 描述符耗尽（ENOSPC/EMFILE）降级轮询；chokidar 的同步 `close()` 会卡 UI → watcher 放 worker 线程。

---

## 2. 路线 A：tokscale CLI 集成契约

### 2.1 获取与版本管理

- npm 包 `tokscale`（平台二进制在 optionalDependencies `@tokscale/cli-win32-x64-msvc` 等，bin 在 `bin/tokscale(.exe)`）。
- token-monitor 用 vendored fork：`scripts/vendor/tokscale.json` 锁定 fork/commit/每平台 sha256，`ensure-vendored-tokscale.js` 下载替换二进制（校验 sha256 + `--version` 冒烟 + 原子 rename）。fork 增加了 session/workspace 分组、DSH v3+ 解析等能力——**upstream 4.15.1 基线不支持 DSH 版本化转录**。
- 铁律：只有 app/agent/打包入口执行 ensure 下载；install/lint/test 永不下载（离线可构建可测试）。

### 2.2 扫描调用

```bash
tokscale --json --client <csv> --group-by client,workspace,session,model [--today|--month|--since YYYY-MM-DD] [--no-spinner] [--home <PATH>]
```

- `--client`：逗号分隔或重复传；用**scan ids**（见 §2.4 映射，如 `micode,micode-desktop`，裸 `mimo` 会 exit 2）。
- `--group-by`：可选 `model` / `client,model` / `client,provider,model` / `workspace,model` / `session,model` / `client,session,model` / `client,workspace,session,model`（token-monitor 用最后一个，拿到会话+工作区归属；不支持时降级 `client,session,model` 并按二进制记住）。
- `--home <PATH>`：读别的 home（WSL 扫描用）；注意部分客户端固定 env/字面量路径（见 §5 各条）。
- 超时 + SIGTERM→SIGKILL 受控终止；stdout 用 JSON、stderr 截断。
- 未知 client（exit 2 + stderr 提到 `--client`）：用 `--help` 解析 supported clients 做能力探测，按二进制身份缓存探测结果，重试时从 client 列表剔除。

### 2.3 输出 JSON schema

顶层：`groupBy, entries[], totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalMessages, totalCost, processingTimeMs`。

每个 entry（`--group-by client,workspace,session,model` 实测）：

```jsonc
{
  "client": "dsh",              // 客户端 id（scan id）
  "mergedClients": null,        // 并行归并时的多客户端串
  "workspaceKey": "E:/项目/token", "workspaceLabel": "token",
  "sessionId": "session-4a45…",
  "model": "deepseek-v4.1-flash",   // 服务端实际模型（DSH 语义）
  "provider": "router",             // 路由供应商（dsh 网关 / opencode profile）；无则为 null
  "input": 3302648, "output": 121652, "cacheRead": 11003392,
  "cacheWrite": 0, "reasoning": 175338,
  "messageCount": 133, "cost": 8.79,
  "performance": { "msPer1KTokens": null, "totalDurationMs": 0, "timedTokens": 0, "sampleCount": 0, "tokenCoverage": 0 }
}
```

消费端要点：`performance` 里 duration 覆盖率参差，吞吐只对携带 duration 的行计数（分子分母必须描述同一批行）；JSON 深走读防御式解析，不假设固定布局。

### 2.4 客户端 id 映射与能力清单

`--help` 里 `--client` 的 possible values 即二进制能力（50+，含 `synthetic`）。display id → scan ids 映射（**必须经映射层**，裸 display id 可能被拒）：

| display id | scan ids |
|---|---|
| antigravity | `antigravity-cli, antigravity-extension`（custom scan 另交 `antigravity, antigravity-cli`） |
| mimo | `micode, micode-desktop`（裸 `mimo` 被拒） |
| devin | `devin-cli, devin-desktop` |
| kilo | `kilo, kilocode`（custom scan 交 `kilocode`） |

**分区不变量**：display id 必须是 `normalizeClientName()` 的不动点；别名必须归回父 id 且被 filter 展开；filter 永不产出 `synthetic`（否则定向扫描退化全量）。

### 2.5 其他子命令

| 子命令 | 用途 |
|---|---|
| `graph` | 按日历史图 JSON（token-monitor 的 Trends/热力图数据源；`--client` 过滤，370 天滚动窗） |
| `pricing <model>` / `models` / `monthly` / `hourly` | 定价查询与各种报告 |
| `clients` | 列出本地扫描位置与会话数（诊断） |
| `cursor` / `antigravity` / `trae` / `codex` 等 | 自同步集成：把官方数据搬到 tokscale 缓存（见 §2.6） |
| `headless` | 子进程输出捕获跟踪（codex exec --json 等无痕会话） |
| `config` / `import` / `submit` 等 | 配置、历史导入、社交平台提交 |

历史图消费要点：`parseGraphResult → normalizeHistory`（370 天窗、本地日键、客户端别名/模型名归一、多源 merge）。

### 2.6 自同步（cursor / antigravity 模式）

某些客户端的用量不在本地明文文件里，需要主动调 tokscale 的集成子命令把数据搬进缓存目录再扫描：

- **cursor**：缓存 `<tokscale有效home>/.config/tokscale/cursor-cache`（home 相对**字面量**，`TOKSCALE_CONFIG_DIR` 移不动）；签名会话子进程同步。
- **antigravity**：缓存 `<tokscaleConfigDir>/antigravity-cache`（走 get_config_dir，尊重 `TOKSCALE_CONFIG_DIR`——与 cursor 刻意不同）；源数据在 `~/.gemini/{antigravity,antigravity-ide,antigravity-backup}`，另有 CLI parse-local 与 IDE RPC 两条腿。
- 节流：进程级单例限速（常规 5 分钟、源事件触发 10 秒地板）；**缓存目录绝不 watch**；只读扫描重写 `*.db-shm` 需要丢自致事件。

### 2.7 定价目录与自定义定价

- 内置快照：pricing-litellm / pricing-openrouter / models-dev.json；`pricing <model>` 查询。
- 自定义：`<configDir>/custom-pricing.json`（原子写 + managed-ids sidecar，保留用户手写条目）；目录 mtime 作为 revision 参与缓存失效。
- provider hint：模型 key 内嵌厂商段决定选哪家官方价（`deepseek-ai`→`deepseek` 等别名折叠；`-cn` 区域端点**绝不**折叠——alibaba 与 alibaba-cn 45 个共享模型里 41 个价格不同）。

---

## 3. 路线 B：从零自研解析（token-monitor 的本地适配器模式）

### 3.1 架构

```
数据根解析 clientSources → 探测 clientSourceObservations → watch 归属 → 解析适配器
→ 造 tokscale 形状 JSON（buildTokscaleJson）→ extractUsageFromTokscale → 归一化/增量/聚合
```

本地解析客户端不进 tokscale `--client` 过滤（`LOCALLY_PARSED_CLIENT_IDS`），其余与 tokscale 客户端同一条归一化管道。

### 3.2 会话身份与去重

- session id：文件派生 + 数据根指纹（如 proma 的 `<文件名>@<root sha256 前 12 位>`），防止重装/迁移后跨根混叠；
- message id：`<client>:<source>:<内容hash>:<session>:<消息id>`；同一消息多 chunk 取聚合值最大的一条；**两种存储代际之间没有已验证的跨格式身份时，不要发明**（宁可保持两源独立身份）。

### 3.3 读取预算（fail-closed）

遍历要有硬上限：目录深度 6、文件数 5000、总量 1 GiB、行数 100k、单行 32 MiB；一旦开始收集，任何错误**中止整个收集**保留最后完整快照（宁缺勿错）。SQLite 只读 + busy_timeout；无 sqlite 时回退 `node:sqlite`。

### 3.4 会话元数据最小集

标题 / startedAt / lastUsedAt / 项目归属（cwd → 归一 key）/ 运行状态与上下文占用（读前先判断"是否还值得读"——30 分钟活跃窗）。各客户端适配器见 §5。原则：元数据绝不反哺 token 计数；标题不从 prompt 内容猜（DSH 只认 `session/title` 事件）。

### 3.5 状态推导

presence（数据目录存在）→ waiting（有目录无用量）/ active（allTime 有用量）/ missing；健康检查共享同一份文件系统探测。WSL：只扫**运行中**的发行版（注册表 gate），绝不启动停着的 distro，串行扫描，全 tick 才刷新。

---

## 4. 客户端数据源总表

> 32 个 tracked client（`clientCatalog.js`）。注意：`factory/trae/alibaba/thirdparty/deepseek/typesafe/openrouter/minimax/volcengine/ollama/qoder/zai/zaiteam` 是**额度（limits）供应商**，不是 tracked client；`gemini` 只是渲染标签。

| id | label | 数据格式 | 根目录类型 | 本地解析 | 自同步 | provider 维度 |
|---|---|---|---|---|---|---|
| claude | Claude Code | JSONL | env(CLAUDE_CONFIG_DIR)/home | 否 | 否 | 无 |
| codex | Codex | JSONL | env(CODEX_HOME)/home/optional | 否 | 否 | 无 |
| opencode | OpenCode | SQLite + legacy JSON | xdg | 否 | 否 | **有** |
| hermes | Hermes Agent | SQLite(state.db) | env(HERMES_HOME)/home/win-localappdata | 否 | 否 | 无 |
| openclaw | OpenClaw | JSONL + SQLite | home | 否 | 否 | 无 |
| cursor | Cursor | SQLite（tokscale 缓存） | home(.config 字面量) | 否 | **是** | 无（auto→cursor-auto） |
| antigravity | Antigravity | SQLite(*.db, WAL) | tokscale 配置目录 + home(.gemini) | 否 | **是** | 无 |
| cline | Cline | JSONL | vscode-globalStorage/home(.cline) | 否 | 否 | 无 |
| amp | Amp | JSON(T-*.json) | xdg | 否 | 否 | 无 |
| droid | Factory Droid | JSONL + settings.json | home(.factory) | 否 | 否 | 无 |
| kimi | Kimi | JSONL(wire.jsonl) | home/…/.kimi-code/平台 appdata | 否 | 否 | 无 |
| qwen | Qwen | JSONL | home(.qwen) | 否 | 否 | 无 |
| grok | Grok Build | JSONL + 日志 JSONL | env(GROK_HOME)/home(.grok) | 否 | 否 | 无 |
| copilot | GitHub Copilot | SQLite + JSONL + OTel | home(.copilot)/vscode-workspaceStorage | 否 | 否 | 无 |
| pi | Pi | JSONL | home(.pi) | 否 | 否 | 无 |
| omp | Oh My Pi | JSONL | home(.omp) | 否 | 否 | 无 |
| zed | Zed | SQLite(threads.db) | xdg + mac/win 原生 | 否 | 否 | 无 |
| kilo | Kilo | SQLite(kilo.db) + 任务 JSON | xdg + vscode-globalStorage | 否 | 否 | 无 |
| commandcode | Command Code | JSONL | home(.commandcode) | 否 | 否 | 无 |
| mimo | Xiaomi MiMo | SQLite(mimocode.db) | xdg + mac orca 沙箱 | 否 | 否 | 无 |
| zcode | ZCode | JSONL + SQLite | home(.zcode) | 否 | 否 | 无 |
| kiro | Kiro | SQLite + JSON/会话文件 | home(.kiro)/vscode-globalStorage | 否 | 否 | 无 |
| codebuddy | CodeBuddy | JSONL + 扩展日志 | home(.codebuddy)/平台 Logs | 否 | 否 | 无 |
| workbuddy | WorkBuddy | JSONL(projects/*.jsonl) | home(.workbuddy/.workbuddy-ai) | 否 | 否 | 无 |
| proma | Proma | JSONL | home(.proma) | **是** | 否 | 无（固定 'proma'） |
| qodercn | Qoder CN | SQLite(local.db) + JSONL | 平台 appdata + home(.qoder-cn) | **是** | 否 | 无 |
| reasonix | Reasonix | JSONL(stats) + sidecar | env(REASONIX_*)/home/win-appdata | 部分（native 视图） | 否 | 无 |
| dsh | DeepSeek Harness | zstd JSONL | env(DSH_HOME)/home(.dsh) | 部分（元数据/详情） | 否 | **有** |
| cherrystudio | Cherry Studio | JSONL(Claude 兼容) | 平台 appdata | 否 | 否 | 无 |
| lmstudio | LM Studio | .log 日志文本 | env(LM_STUDIO_HOME)/home(.lmstudio) | 否 | 否 | 无 |
| unsloth | Unsloth | SQLite(studio.db) | env(UNSLOTH_STUDIO_HOME)/home(.unsloth) | 否 | 否 | 无 |
| devin | Devin | SQLite(sessions.db) + NDJSON(acp-events) | xdg/home/appdata | 否 | 否 | 无 |

---

## 5. 分客户端明细

> 每条：根目录 → 格式 → token 口径 → 模型/供应商 → 去重 → watch → 元数据 → 特殊机制 → 坑。出处为代码常量/函数名与 docs/providers 笔记。

### claude
- **根**：`CLAUDE_CONFIG_DIR`（非空才生效）或 `~/.claude` → `projects/`、`transcripts/`；WSL 标记同路径。
- **格式**：JSONL 转录（超大记录有界 head/tail 读）。
- **口径**：tokscale 聚合；上下文占用 = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`（不含 output），缺 cache 字段视为 0。
- **模型**：转录内 `message.model`；`[1m]` 后缀映射 1M 上下文窗口，其余回退 200K。
- **watch**：递归整目录。**元数据**：持久化 `custom-title`/`ai-title`、turn 状态（最新 `stop_reason` + 其后的真实 user prompt）、上下文占用（活跃窗门控）。
- **坑**：compact 边界把上下文对清零；不得误读嵌套在 tool 内容里的 `model`/`usage`。

### codex
- **根**：`CODEX_HOME`（非空）或 `~/.codex` → `sessions/`、`archived_sessions/`；另有 `TOKSCALE_HEADLESS_DIR`（替换二者）或 `~/.config/tokscale/headless/codex`、`~/Library/Application Support/tokscale/headless/codex`（所有平台都扫，optional）。
- **格式**：JSONL rollout（`codex exec --json`）。
- **口径**：占用来自最新 `token_count` 事件的 `info.last_token_usage`；容量 `info.model_context_window`；**`total_token_usage` 绝不是占用**。
- **watch**：递归。**元数据**：thread db join 标题、有界尾窗读上下文、workspace 归属。
- **坑**：Store/npm 安装路径差异影响 CLI 发现；Session Detail 有 WSL 回退（claude/codex/dsh 三个客户端支持）。

### opencode
- **根**：`$XDG_DATA_HOME/opencode`（tokscale `PathRoot::XdgData`，tokscale 有效 home 在 Windows 优先绝对 $HOME）。
- **格式**：`opencode.db` / `opencode-<channel>.db` SQLite + legacy `storage/message/*/*.json`。
- **provider**：**有**——tokscale 行携带路由 profile 名。
- **watch**：bounded——db+wal/shm 白名单；storage 只到 `message/<session>/*.json` 一层。
- **坑**：本地 ledger 是设备级，不能归属单个凭据 profile；WAL/SHM 是活跃写信号。

### hermes
- **根**：`HERMES_HOME` > `~/.hermes`（有 state.db）> Windows `%LOCALAPPDATA%\hermes`；加 `profiles/<name>/`。
- **格式**：SQLite（state.db + wal/shm）。
- **watch**：bounded——只留 `state.db(+wal/shm)` 文件名（**整目录递归曾打满 CPU：运行时 15 万+文件，issue #38**）。
- **坑**：profile 目录在 home 内嵌套，matcher 要保留 watch 根本身。

### openclaw
- **根**：`~/.openclaw/agents`。
- **格式**：JSONL（sessions/ 与迁移归档 session-sqlite-import-archive/）+ 每代理 `openclaw-agent.sqlite` + 内嵌 Codex rollout（`agent/codex-home/{sessions,archived_sessions}`，legacy `agent/cli-auth/codex/<profile>`）。
- **watch**：bounded——agent id 第一层保留；`agent/` 下只留 codex-home、cli-auth/codex/<profile>、`openclaw-agent.sqlite(+wal/shm)`。
- **坑**：agent 目录其余部分是运行时状态（巨大依赖树），必须裁剪。

### cursor
- **根**：tokscale 缓存 `~/.config/tokscale/cursor-cache`（**home 相对字面量**，`TOKSCALE_CONFIG_DIR` 移不动；与 antigravity 刻意不同）。
- **机制**：self-sync（签名会话子进程）写缓存 → tokscale 扫缓存。
- **模型**：旧 CSV `auto` 与 JSON `default` 统一 `cursor-auto`（仅限 cursor）。
- **watch**：**缓存根不 watch**（自写自触发，issue #15）；watch 源事件根触发 sync；单 throttle 常规 5 分钟 / 事件 10 秒地板。
- **元数据**：桌面 `state.vscdb` 的 `composerHeaders` 表按 conversation id 取标题（只读，db 变化时刷新缓存）。
- **坑**：旧锚点需重扫一次防新旧模型 key 混用；凭据变化触发一次定向 sync。

### antigravity
- **根**：① tokscale 缓存 `<tokscaleConfigDir>/antigravity-cache`（尊重 `TOKSCALE_CONFIG_DIR`）；② `~/.gemini/antigravity/conversations`；③ CLI parse-local `${GEMINI_CLI_HOME||~/.gemini}/antigravity-cli/conversations`。
- **格式**：每会话一个 SQLite `*.db`（WAL）；IDE 还经 RPC 从运行中的 language server 取数（`brain/`+`conversations/` 只枚举会话 id）。
- **机制**：self-sync（`tokscale antigravity sync`）归一化写缓存；`SELF_WATCHED_SQLITE_SIDECAR_CLIENTS` 成员（丢自致 -shm 事件）；sync.lock 崩溃安全。
- **watch**：原生根 bounded——`{annotations, brain, conversations}` + `agyhub_summaries_proto.pb`；brain 只 watch 一层；CLI 目录显式递归 watch；缓存目录不 watch。
- **坑**：CLI 与扩展解析同一 `*.db` 格式，custom root 两条腿各解析一次防双计；WSL 只在全扫检查、绝不启动 distro。

### cline
- **根**：VS Code `globalStorage/saoudrizwan.claude-dev/tasks`（mac App Support / `~/.config/Code` / `%APPDATA%\Code` / `~/.vscode-server`）+ CLI `CLINE_SESSION_DATA_DIR` > `CLINE_DATA_DIR/sessions` > `CLINE_DIR/data/sessions` > `~/.cline/data/sessions`。
- **格式**：JSONL。
- **口径坑**：`metrics.inputTokens` 沿上游约定摇摆（OpenAI 式含缓存/Anthropic 式不含），tokscale 无条件减 cache read → `cacheReadTokens > inputTokens` 的行输入可为负（约 3.6% 消息，上游算术）。
- **身份**：Desktop 与 CLI 写同一棵 `~/.cline/data` 树（`source: cli|desktop`），**刻意不拆 id**（watch 归属 key）。
- **watch**：递归。

### amp
- **根**：`$XDG_DATA_HOME/amp/threads`（所有平台都走 XDG，mac/win 也是）。
- **格式**：线程 JSON（`T-*.json`，内含 usageLedger 与每 assistant 消息 usage）。
- **坑**：Windows `$HOME` 与用户 profile 分歧曾导致"检测到但数据来自别的目录"——XDG 回退挂在 tokscale 有效 home 上。

### droid
- **根**：`~/.factory/sessions`（所有平台）。
- **格式**：`<uuid>.jsonl` 转录 + `<uuid>.settings.json`（**累计** tokenUsage 五桶：inputTokens/outputTokens/cacheCreationTokens/cacheReadTokens/thinkingTokens；`factoryCredits` 不计入）+ 两代索引 JSON（v6/v2）；tokscale 递归扫 `*.settings.json`。
- **口径**：settings.json 是累计值，模型往返完成后才写——刚应答的会话可能短暂为 0。
- **元数据**：两代索引调和（优先当前代），title/时间戳/cwd→项目；索引异步写会晚于扫描（`retryAfterTimestampFallback: true`，最早/最晚调和）。
- **坑**：`FACTORY_HOME_OVERRIDE` 刻意不咨询；`factory` 是独立 limits 供应商，若加为 tracked client 会双计；Session Detail 刻意不支持（JSONL 是请求/事件流非 Claude 形状）。

### kimi
- **根**：① `~/.kimi/sessions`；② `$KIMI_CODE_HOME/sessions`（回退 `~/.kimi-code`）；③ Kimi Work `<平台 appdata>/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions`（win 另加 relocated `shareDir`，optional）。
- **格式**：各前端统一 `wire.jsonl`。
- **口径**：只有 `usage.record` 行且 `usageScope: "turn"` 计数；`step.end` 重复同轮 usage（跳过防双计）；`"session"` scope 是运行时簿记（compaction），排除 → 总量比厂商低约 1%。
- **身份**：CLI uuid / `session_*` / Work `conv-*`（`ctitle-*` 按独立会话计）；工作区归属由 `workspaces.json` + `session_index.jsonl` join。
- **元数据**：兄弟 `state.json` 两代格式（legacy `workDir`+ISO；current `version:2` `cwd`+epoch+`titleKind` replaceable/generated/custom）；标题单行 96 码点上限；零 stat 探测。
- **坑**：空白 `KIMI_CODE_HOME` 视为未设置；`lastPrompt`/`custom`/桌面 minidb 刻意不读。

### qwen
- **根**：`~/.qwen/projects`（Claude 形状家族 JSONL）。递归 watch。无本地适配器。

### grok
- **根**：`GROK_HOME` 或 `~/.grok` → `sessions/` + `logs/unified.jsonl`（精确文件 sourcePath）。
- **格式**：会话 JSONL + 统一日志 JSONL（双源扫描器）。
- **watch**：sessions 递归；logs 只 watch 该文件本身（父目录可能是 $HOME）。

### copilot
- **根**：① `~/.copilot/otel`；② `~/.copilot`（`data.db` 桌面 + `session-store.db` CLI）；③ VS Code `User/workspaceStorage`（mac/win/`~/.config/Code`/`~/.vscode-server`）；④ `COPILOT_OTEL_FILE_EXPORTER_PATH` 精确文件（optional）。
- **格式**：SQLite ×2 + `workspaceStorage/*/chatSessions` JSONL + OTel 导出器 JSONL。
- **watch**：bounded——`~/.copilot` 只留两个 db(+wal/shm) + otel 子树；workspaceStorage 只留 `chatSessions/` 与 `workspace.json`；otel check 不建嵌套 watch；导出器 watch 其**父目录**（文件可后出现）。
- **特殊**：**OTel exporter 需用户手动启用**（设 `COPILOT_OTEL_FILE_EXPORTER_PATH`）。
- **坑**：漏掉 session-store.db 的 watch 会让 CLI 用量只能等全 tick。

### pi / omp
- **根**：`~/.pi/agent/sessions` / `~/.omp/agent/sessions`。
- **坑**：**omp 固定根、刻意忽略 `PI_CODING_AGENT_DIR`**（Pi 读它）；两者曾折叠为一行，后按身份拆分机制拆回。

### zed
- **根**：`$XDG_DATA_HOME/zed/threads` + `~/Library/Application Support/Zed/threads` + `%LOCALAPPDATA%\Zed\threads`（三根都 watch）。
- **格式**：`threads.db` SQLite（+WAL/SHM）。
- **watch**：bounded——只 watch db(+wal/shm)。
- **坑**：limits（dashboard Cookie）与用量完全分离；BYOK 模型归属实际产生记录的一方。

### kilo
- **根**：① `$XDG_DATA_HOME/kilo`（sourcePath 钉 `kilo.db`）；② VS Code `globalStorage/kilocode.kilo-code/tasks`（`~/.config/Code` + `~/.vscode-server`）。
- **坑**：CLI db 拒绝额外根（sourcePath 钉死）；**原生 mac/win VS Code 根刻意不列**（tokscale 尚不扫描，列了会成死 watch 与假 presence）；custom root 只交 `kilocode` 腿。

### commandcode
- **根**：`~/.commandcode/projects`。
- **格式**：递归会话 JSONL；**`.checkpoints.jsonl` 后缀被 tokscale 明确跳过**。
- **watch**：bounded——保留普通 `.jsonl`，剪掉 checkpoints 与无关项目元数据。

### mimo
- **根**：① `$XDG_DATA_HOME/mimocode`；② mac orca hook 沙箱 `~/Library/Application Support/orca/mimocode-hooks/shared/data`（tokscale `discover_micode_dbs_in_dirs` 联合两根）。
- **格式**：`mimocode(.db / -<channel>.db)` SQLite（只读直接子级）；旁边数 GB 的 `log/` 树不解析。
- **watch**：bounded——mimocode*.db(+wal/shm)。
- **坑**：**别名 fossil**——裸 `mimo` 被拒，scan ids 必须 `micode,micode-desktop`；`session.version` 以 `desktop-` 开头的行重标为 `micode-desktop`；**claude-import 服务自动导入 Claude Code 会话且不去重 → 同一份工作在 claude 与 mimo 下各计一次（上游行为，被接受）**。

### zcode
- **根**：`~/.zcode/projects` + `~/.zcode/cli/db/db.sqlite`（sourcePath 钉死）。
- **格式**：v2 起直接 SQLite 路径 + projects JSONL。
- **watch**：bounded——db.sqlite(+wal/shm)；`SELF_WATCHED_SQLITE_SIDECAR_CLIENTS` 成员。

### kiro
- **根**：① `~/.kiro/sessions`（CLI+IDE 共用，data.sqlite3）；② IDE `globalStorage/kiro.kiroagent`（mac App Support / `~/.config/Kiro` / `~/.config/kiro` / `%APPDATA%\Kiro`）；③ kiro-cli `~/.local/share/kiro-cli`（home 相对字面量，**不走 XDG**）+ mac `~/Library/Application Support/kiro-cli`。
- **watch**：IDE globalStorage 是唯一的 **interval-only** 源（真实树可达数万个 watch——只走定时 tick，不 watch）；kiro-cli bounded 到 data.sqlite3(+wal/shm)；sessions 递归。globalStorage 树内接受任意深度 `.chat`/`.json`/无扩展名文件。
- **坑**：Kiro/kiro 大小写两种拼写是刻意的（大小写敏感 FS 的免费保险）；WSL 下 Windows 读不了活跃 SQLite → 在 WSL 内跑 headless agent。

### codebuddy
- **根**：`~/.codebuddy/projects` + 扩展日志 `CodeBuddyExtension/Logs`（home 相对 Windows 形状路径在**所有平台**扫 + 原生 `data_local_dir` 拼写：win `%LOCALAPPDATA%` / mac App Support / Linux xdg）。
- **watch**：bounded——Logs 下只留 `{CodeBuddyIDE, VSCode}` 子树。

### workbuddy
- **根**：`~/.workbuddy/projects` + `~/.workbuddy-ai/projects`（5.5 迁移到 `-ai`，tokscale 4.17.0 双扫）。
- **watch**：只 watch 两个 projects 目录，不 watch 整个 app home。
- **坑**：5.6.0+ 凭据被 app 自有 key 加密（`{$wbEncrypted:1}`），区分 `encrypted/absent/expired` 读态、拒不解密；首个含 canonical 状态的目录决定一切。

### proma（本地解析）
- **根**：`~/.proma/agent-sessions`（顶层非递归，每会话一个 `.jsonl`）。
- **口径**：`type==='assistant'` 行的 `message.usage`（input/output/cache_read/cache_creation 四桶；reasoning 恒 0）；同一消息多 chunk 取 total 最大的一条折叠；成本按定价目录估算，无费率的桶返回 null。
- **模型**：`message.model || obj._channelModelId || 'unknown'`；行内 `provider: 'proma'` 固定。
- **身份**：session id = `<文件名>@<root sha256 前 12 位>`；消息 id = `message.id || obj.uuid`。
- **输出**：造 tokscale 形状 JSON 走共享归一化；每 tick 每文件只读一次。

### qodercn（本地解析，默认不跟踪）
- **根**：① legacy DB `<平台 appdata>/QoderCN/SharedClientCache/cache/db/local.db`（`TOKEN_MONITOR_QODER_CN_DB_PATH` 覆盖）；② JSONL 树 `TOKEN_MONITOR_QODER_CN_PROJECTS_PATH` > `$QODERCN_CONFIG_DIR/projects` > `~/.qoder-cn/projects`。
- **口径**：DB `token_info` 的 `prompt_tokens/cached_tokens/completion_tokens` → `input = max(0, prompt−cached)`、`cacheRead = min(prompt, cached)`、`cacheWrite = 0`；JSONL 共享 Claude envelope 但**不共享语义**（`input_tokens` 已含 cached，需减法；`context_usage_ratio` 用于验证）；`prompt+output===0` 的行不计入（计划计费行只有 credits）。
- **模型**：DB `model_info.model_key` / JSONL `message.model`（`qoder-custom-<uuid>/` 前缀剥离；退役内码有显示名映射）；routing tier（auto/ultimate/…）不参与计价。
- **读取预算**：深度 6、5000 文件、1 GiB、100k 行、单行 32 MiB，fail-closed；`sqlite3 -readonly -json` 失败回退 `node:sqlite`。
- **坑**：两代存储无跨格式 message key，不发明；JSONL 零 token 行 ≠ 0 用量；输出 token 无法从 credits 反推；定价 6h TTL 缓存；db 路径与 projects 目录都参与锚点指纹。

### reasonix
- **根**：`REASONIX_STATE_HOME` > `REASONIX_HOME` > win `%APPDATA%\reasonix` / 其他 `~/.reasonix`，再拼 `stats/`（支持 `${VAR:-default}` 展开、`~`、相对路径——镜像上游 cleanEnvDir）。**不走 WSL**。
- **口径**：聚合总量只来自 tokscale；本地 native 行只用于 UI（标题/项目/消息/遥测），**绝不进聚合、history、archive、sync**（fail-closed 移除一切 Reasonix 形状普通会话，防双计）。
- **watch**：native sidecar 根 bounded——丢弃 sidecar 文件与目录事件，只对真实文件事件失效 native 缓存。
- **坑**：metadata 重命名不得把旧会话挪到今天；官方事件 replay 只接受受支持 schema，torn tail 保留最后可信状态；paths.js 无 Node 内建（可 vendored 进 Worker）。

### dsh
- **根**：`DSH_HOME` 或 `~/.dsh` → `sessions/<encoded-cwd>/<session-id>/`。
- **格式**：**zstd 压缩 JSONL**，版本化文件名 `session[.vN].jsonl(.zstd)` 并存（v3+ 保留旧文件；一帧一次 flush，torn 尾帧常见；未压缩 `session.jsonl` 是降级路径）。逐帧定位解析（见 §1.5）。
- **口径**：envelope `{type, seq, time, data}`；usage 在 `data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}` 五桶齐全；`outputTokens` 原样透传（reasoning 是 output 子集）。
- **模型/供应商**：`data.message.source.{model, provider}`——**provider 维度明确存在**（网关路由）；provider 实际服务模型可能在 `source.replayState.response.responseModel`（served model 语义）。
- **去重**：writer 可重放已 flush 行——按消息身份+时间+路由+token 签名去重；v3/legacy 并存 union 去重不双计。
- **元数据**：标题取最新 durable `session/title` 事件（绝不从 prompt 内容推导）；`data.source.kind === 'user'` 才是用户 prompt；`seedLength`/`isSeeded` 跳过 fork 继承前缀；标题/turn/上下文来自同一增量折叠。
- **坑**：文件名匹配必须泛化 `session[.vN].`（upstream 4.15.1 基线不支持——vendored fork 补齐）；Session Detail 有 WSL 回退。

### cherrystudio
- **根**：V2 `%APPDATA%/CherryStudio/Data/Agents/.claude/projects` + legacy `CherryStudio/.claude/projects`（mac/win/Linux `~/.config`）。
- **格式**：标准 Claude Code 兼容 JSONL；**同一 API 调用每次流式响应追加 3-4 次，解析器去重**；V2 副本胜、legacy 补缺。
- **坑**：两代目录共存属正常形态。

### lmstudio
- **根**：`LM_STUDIO_HOME`（非空白）或 `~/.lmstudio` → `server-logs/`。
- **格式**：按月组织的 `.log` 文本（OpenAI 兼容本地服务日志），tokscale 从日志行解析推理用量。

### unsloth
- **根**：`UNSLOTH_STUDIO_HOME`（非空时 `studio.db` 直接在其下）或 `~/.unsloth/studio`，sourcePath 钉 `studio.db`。
- **格式**：SQLite。读 chat 消息中的标量推理元数据 + local API usage events，不读消息内容。
- **坑**：未知/自定义/订阅路线不定价（显示 0 ≠ 免费）；WSL 分享下 Windows 读不了活跃 db → headless agent 进 WSL。

### devin
- **根**：CLI——`$XDG_DATA_HOME/devin/cli`（回退 `~/.local/share`）+ win `%APPDATA%/devin/cli` + 无条件 `AppData/Roaming/devin/cli`（sourcePath 钉 `sessions.db`）；Desktop——`acp-events` NDJSON（mac/win/`~/.config/Devin|devin` 两拼 + 无条件 AppData 路径）。
- **口径**：CLI `message_nodes.chat_message` 的 `metadata.metrics`；Desktop `usage_update` 事件；两源同会话时 **CLI 数据库权威**。
- **模型**：`metadata.generation_model`；**`adaptive` 是路由值不是模型 id**。
- **watch**：CLI bounded 到 sessions.db(+wal/shm)；acp-events 递归；`acp-messages/` 每会话 db 不是源。
- **坑**：**Desktop 默认 `devin-cloud` agent 不写本地用量**（服务端计量）——目录存在但 token 为 0 是源限制不是检测故障；scan ids 必须 `devin-cli,devin-desktop`。

---

## 6. 横切机制速查（迁移必带）

- **id 映射**：`antigravity→[antigravity-cli, antigravity-extension]`、`mimo→[micode, micode-desktop]`、`devin→[devin-cli, devin-desktop]`、`kilo→[kilo, kilocode]`；遗留别名 `kilocode→kilo`、`devin-cli/desktop→devin`、`micode→mimo`、`omp 从 pi 拆出`。
- **分区不变量**：id 是 `normalizeClientName()` 不动点；别名归回父 id；filter 永不产出 `synthetic`。
- **watch 总纲**：重叠根策略取 union；Windows 根 realpath（8.3/junction → libuv abort）；自写缓存目录不 watch；`-shm` 自反馈丢弃；超大目录白名单化（hermes 案例）；每客户端一个 `INTERVAL_ONLY` 例外（kiro-ide-globalstorage）。
- **自同步防护**：`cursor`/`antigravity` 缓存根不 watch；单 throttle（5 分钟/事件 10 秒地板）；collector 替换时取消 in-flight sync。
- **本地解析白名单**：仅 proma、qodercn；其余全部经 tokscale。
- **env 覆盖汇总**：`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`TOKSCALE_HEADLESS_DIR`、`XDG_DATA_HOME`、`HERMES_HOME`、`CLINE_SESSION_DATA_DIR/CLINE_DATA_DIR/CLINE_DIR`、`GROK_HOME`、`KIMI_CODE_HOME`、`GEMINI_CLI_HOME`、`COPILOT_OTEL_FILE_EXPORTER_PATH`、`DSH_HOME`、`REASONIX_STATE_HOME/REASONIX_HOME`、`LM_STUDIO_HOME`、`UNSLOTH_STUDIO_HOME`、`TOKEN_MONITOR_QODER_CN_DB_PATH`、`TOKEN_MONITOR_QODER_CN_PROJECTS_PATH`、`QODERCN_CONFIG_DIR`、`TOKSCALE_CONFIG_DIR`、`TOKSCALE_EXTRA_DIRS`（自定义目录 `client:dir` 格式）、`TOKEN_MONITOR_CLIENTS`。
- **自定义扫描目录**：绝对路径/无逗号/限额（全局 64、每客户端 16）；拼进 `TOKSCALE_EXTRA_DIRS`；参与锚点指纹（变了强制全扫）。

---

## 7. 迁移检查清单

把这套检测能力搬去其他项目时，按需带走：

1. **只要数据**（最小）：装 tokscale（npm 或 vendored fork），按 §2.2/§2.3 调用与消费 JSON。注意版本 pin（upstream 与 fork 能力差异）、scan id 映射、能力探测。
2. **要实时性**：加 §1.6 watch 策略 + §1.4 增量恒等式（含锚点持久化与指纹失效）。
3. **要分供应商**：保留 `provider` 维度（§1.2），聚合键用 model+provider，不要只按 model。
4. **要某个特定客户端的深读**（标题/项目/详情）：抄 §5 对应条目 + token-monitor 的 `providers/<id>/` 适配器（多为有界读取 + 缓存 + 活跃窗门控）。
5. **要多设备聚合**：wire record 形状见 `docs/API.md`（periods 五桶 + clientStatus + periodWindows 过期冻结 + stale 灰显），Hub 归一化在 `normalizeDeviceRecord`（未知枚举降级 unknown、计数封顶、原型敏感键拒收）。
6. **测试**：数据源测试要清空 `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_*/<各客户端 HOME env>`（真机泄漏会让正确实现红测，见 token-monitor `tests/helpers/sourceEnv.js`）；时区敏感断言用本地日历分量构造时间戳。
