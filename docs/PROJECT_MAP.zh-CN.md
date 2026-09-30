# Token Monitor 项目地图（AI 导航文档）

> **目的**：让 AI 与人在不重复通读源码的情况下，直接定位"某个功能在哪个文件哪个函数"。
> **用法**：先查本文档的目录与 §9 修改速查表，再只读目标文件的目标函数。每个子系统还有更深的契约文档（`docs/architecture.md`、`docs/providers/`），本文档负责告诉你**去哪找**，契约文档负责告诉你**改时注意什么**。
> **基线**：v0.63.1（2026-09）。文中行号是近似锚点，代码演进后请改用符号名搜索。

---

## 0. 项目一句话

Electron 桌面小组件，实时监控 30+ AI 编程工具（Claude Code、Codex、Cursor、Copilot、OpenCode、火山方舟等）的 **token 用量 / 成本 / 账号额度**；本地优先（扫描本机数据文件），可选多设备同步（自托管 Node Hub 或 Cloudflare Worker）。纯原生 JS（无框架、无打包器、UMD 挂 window 全局），Node ≥ 22.15。

**五个运行体共享 `src/shared/`**：

| 运行体 | 入口 | 说明 |
|---|---|---|
| Widget（桌面应用） | `src/electron/main.js` | Electron 主进程 + renderer，产品主体 |
| Agent（无头采集） | `src/agent/agent.js` | 定时采集→POST 到 Hub，供 cron/launchd/服务器 |
| Hub（Node 服务器） | `src/hub/server.js`（`npm run hub`，端口 17321） | 接收各设备 ingest，聚合下发 |
| Worker（Cloudflare Hub） | `worker/src/index.js` | 与 Node Hub 同协议的 Serverless 版，自托管用 |
| macOS Widget（原生） | `native/macos/TokenMonitorWidget/*.swift` | WidgetKit 扩展，读 Electron 写的快照文件 |

**全景数据流**（一图流，标注文件）：

```
[客户端写文件]  ~/.claude/** ~/.codex/** 等 30+ 数据目录
   │
   ▼
① watcherWorker.js（chokidar，独占 worker 线程，轮询降级）
   │  postMessage 事件
   ▼
② collector.js :: handleWatchEvent → clientsForWatchPath（事件归属客户端）→ scheduleTick（防抖≥1500ms，重臂不排队）
   │
   ▼
③ collector.js :: runTick → collectUsageOnce
   │   · watch tick：只扫 tokscale --today，month/allTime 用 applyPeriodDelta() 从锚点增量推导（恒等式，非估算）
   │   · full tick：串行 --today → --month → --since（并发会打爆 CPU/IO）；每 1h 强制一次全量
   │   · 旁路：cursor/antigravity 自同步（selfSyncThrottle 限速）；Windows 下 WSL 发行版扫描；proma/qodercn 本地解析
   ▼
④ usage/usageTransform.js（usage worker 线程内）：会话归档（SQLite）→ project() 叠加归档与项目 rollup
   ▼
⑤ usage/deviceRuntime.js：deviceState 组装 wire record（usage + limits + envelope），同时喂给：
   │     · onRecord 观察者（主进程展示）
   │     · sink（orderedSink → 上传通道，按 hubMode 分流）
   ▼
⑥ main.js sendPush（4189）→ 快照 stamp → renderer / 托盘 / edge dock / mac Widget / Discord / 自动导出
   ▼
⑦ renderer 收 stats:push（推送）+ stats:get（拉取兜底轮询）

Limits（额度）独立管道：LimitsRuntime（limits/runtime.js）按 provider 调度探针 → registry fetcher
   → core.js 归一化 → deviceState.updateLimits → 同一个 record 发布。凭证变更只刷新对应 lane，不动 usage。
```

**关键术语**：
- **tokscale**：外部 CLI 二进制（npm `tokscale@^4.17.0`，被 vendor 替换为 fork 构建），所有 token 扫描最终由它执行；本项目只做调度/归一化/展示。二进制管理见 `scripts/vendor/tokscale.json` + `scripts/ensure-vendored-tokscale.js`。
- **tracked client**（31 个）vs **limits provider**（28 个）：两个独立目录。tracked client 是"扫谁的用量数据"（`clientCatalog.js`）；limits provider 是"查谁的账号额度"（`limits/providers.js`）。部分 id 重合但有映射例外（droid→factory、zcode→zai、qodercn→qoder、dsh→deepseek）。
- **hubMode**：`settings.hubMode` ∈ `local`（单机）/ `client`（连远端 Hub）/ `host`（本机就是 Hub），实现集中在 `main.js`（见 §4.1）。
- **UMD 模块**：`src/shared/` 与 `src/electron/renderer/` 的大量文件是 UMD/IIFE，Node 侧 `require`、renderer 侧 `<script>` 加载挂 `window.TokenMonitorXxx`——同一份代码三处用（主进程/renderer/Worker）。
- **@generated Worker 副本**：`worker/src/shared/` 是从 `src/shared/` 拷贝的生成物，**永远不要直接改**；改 `src/shared/` 后跑 `npm run sync:worker`。

---

## 1. 目录总览

```
token-monitor/
├── src/
│   ├── electron/            # Electron 主进程模块（main.js 8.4k 行 + ~50 个可测小模块）+ renderer/（UI）
│   ├── shared/              # 跨运行体共享核心：collector、usage/、limits/、providers/、hub 协议、tokscale 适配
│   ├── agent/               # 无头采集器（agent.js 入口）
│   └── hub/                 # Node Hub 服务器（server.js，createHub 传输无关）
├── worker/                  # Cloudflare Worker Hub（自包含，src/shared/ 为 @generated 拷贝）
├── native/macos/            # macOS 原生 Widget（Swift/WidgetKit）
├── scripts/                 # 构建/发布/打包/tokscale vendored/Worker 同步（~30 个脚本）
├── site/                    # 官网（独立 React+esbuild 静态站，部署 GitHub Pages）
├── tests/                   # node:test，~364 个测试文件，按 shared/electron/hub/worker/scripts/docs/agent 分层
├── docs/                    # architecture.md（跨运行体契约）、API.md（Hub 契约）、providers/（20 篇 provider 笔记）
├── .github/                 # 6 个 workflow + release 模板 + SignPath 配置
├── assets/ icons/           # 应用图标；assets/icons/ 为各 provider/客户端 SVG（mask 用）
└── AGENTS.md                # AI 入口：命令、路由表、Tripwires（雷区）
```

---

## 2. Electron 主进程（src/electron/）

### 2.1 main.js（8389 行）顶层区块图

| 行号≈ | 区块 |
|---|---|
| 1–443 | ~120 个 require + 常量；非打包时 `loadDotEnv()` |
| 443–1969 | Settings 模型：`defaultSettings`(525)、`electronUsageConfig`(746)/`electronLimitsConfig`(774)、受管账号（Codex hydrate 935、Antigravity 1053–1215、Mimo 1215–1365）、Codex 受管 home/登录/系统账号切换（1365–1853，`addCodexManagedAccount` 1566、`performCodexSystemAccountSwitch` 1702）、settings 迁移（1853–1969） |
| 1969–2287 | 窗口 bounds 持久化；**浮动气泡主进程状态机**：`floatingBubblePayload`(1988)、`collapseFloatingBubble`(2111)、`expandFloatingBubble`(2160)、`syncFloatingBubbleAvailability`(2214)；zoomFactor |
| 2287–2671 | 货币覆盖、`ensureCredentialStore`(2301)、**`readSettings()`(2366)**/`saveSettings()`(2566)、`seedInitialLimitProviders`、开机自启、tracked clients 归档 |
| 2671–2940 | `createElectronUsageRuntime`、mac 激活策略/Space 行为、任务栏 z-order、`applyWindowSettings`(2767)、原生材质 `applyNativeMaterial`(2802)、展示投影 `electronPresentationStats` |
| 2939–3146 | Hub 统计缓存（`currentHubStatsCache`）+ limit 失效队列（`queueLimitInvalidation`） |
| 3146–3315 | **hub 模式核心**：`effectiveHubConfig`(3146)、`sendHubPush`(3164)、`startEmbeddedHub`(3189)/`stopEmbeddedHub`(3218)、`postToHub`(3248) |
| 3315–3782 | 共享订阅（hub 作用域）：`effectiveSubscriptions`(3330)、`fetchSharedSubscriptions`(3419)、`writeSharedSubscriptionsNow`(3462)、`adoptOrphanedSubscriptions`(3555) |
| 3782–3960 | `startSyncCollector`(3812，client 模式)、`startHostCollector`(3862)、`startHostStats`(3908)、`injectLocalDeviceStatus` |
| 3941–4189 | mac Widget 接线：`macWidgetConfiguration`(3960)、`ensureMacWidgetSnapshotController`(4103)、`scheduleMacWidgetSnapshot`(4177) |
| 4189–4285 | **`sendPush`(4189，统一推送出口)**；汇率缓存与刷新 |
| 4281–4359 | Discord RPC 展示、`updateTrayDisplay`(4290)、`sendStatus`(4335) |
| 4359–4534 | `startLocalCollector`(4416)、SSE 流（`startStatsStream` 4468/`stopStatsStream` 4462） |
| 4534–4798 | popover（托盘点击弹窗）、第三方凭证续期持久化、**`settingsForRenderer()`(4674，renderer 投影/脱敏)**、系统深色检测、`pushSettingsToRenderer`(4779) |
| 4798–5169 | **Edge Dock 接线**：`ensureEdgeDockController`(5069)、`pushEdgeDockCells`(5010)、`syncEdgeDock`(5131) |
| 5179–5598 | 托盘菜单动作、`configureWindowToggleShortcut`(5373)、`ensureTray`(5392)/`destroyTray`、`enterTrayMode`/`exitTrayMode`(5443)、**`startMode`(5484，hubMode 切换总编排)** |
| 5598–6273 | `stopAll`(5598)、退出、导出、tokscale 管理（5784–5871）、**自动更新**（`runAppUpdateCheck` 6050、`downloadAndPrepareAppUpdate` 6166、`installDownloadedAppUpdate` 6220） |
| 6273–6671 | **`createWindow`(6349)**（frameless/透明/材质/气泡收缩）、Dashboard 窗口(6528)、`rebuildWindow`(6650) |
| 6671–6735 | `app.whenReady` 初始化序列（createWindow → ensureTray → startMode → Discord → 汇率 → edgeDock） |
| 6735–8353 | **全部 IPC 注册区**（见 §2.3） |
| 8359–8389 | app 生命周期（activate/second-instance/before-quit） |

### 2.2 模块清单（src/electron/，按职责分组）

**窗口与行为**
| 文件 | 职责 | 关键导出 |
|---|---|---|
| `windowBehavior.js` | floating/normal/desktop 三种窗口行为 profile | `describeWindowBehavior, normalizeWindowBehavior` |
| `windowState.js` | bounds/最大化持久化恢复、气泡收缩尺寸限制 | `persistWindowState, restoreWindowMaximized` |
| `windowLifecycle.js` | 多窗口事件 handoff、show/reveal 统一入口 | `actionWindowForEvent, showWindow` |
| `windowShortcut.js` | 全局切换窗口快捷键（UMD） | `createWindowShortcutApi` |
| `windowsChrome.js` / `windowsBackdrop.js` / `windowsBackdropMode.js` | Win 圆角 / Accent Blur API / 背景模式归一 | `applyWindowsAccentBlur, normalizeWindowsBackdropMode` |
| `windowsForegroundHook.js` | Win 全局前台切换钩子（收起 popover） | `subscribeForegroundChange` |
| `windowsTaskbarZOrder.js` | 保持 widget 压在任务栏之上 | `createTaskbarZOrderKeeper` |
| `macBackdropMode.js` / `macLiquidGlass.js` / `macosSpaceBehavior.js` | mac 背景模式 / 纯 AppKit Liquid Glass / Space 行为 | `createMacLiquidGlass, setMoveToActiveSpace` |
| `nativeMaterialVisibility.js` | 原生材质可见性（Reduce Transparency 降级） | `syncNativeMaterialVisibility` |
| `backgroundImage.js` | 自定义背景图导入/读取/清除 | `importBackgroundImage` |

**托盘 / Edge Dock / 气泡 / Discord**
| 文件 | 职责 | 关键导出 |
|---|---|---|
| `tray.js` | 托盘核心：图标绘制/菜单模板/popover 定位 | `createTray, buildTrayIcon, buildTrayMenuTemplate, popoverBounds` |
| `trayModeSettings.js` | 托盘模式行为决策（主窗变 popover） | `shouldCreateTray, trayToggleAction` |
| `edgeDock/controller.js` | 拥有 peek/rail/bubble 三窗口 + 光标轮询 + `edgeDock:*` IPC | `createEdgeDockController` |
| `edgeDock/geometry.js` | 纯几何/命中/拖放（无 Electron 依赖，可单测） | `edgeDockCellAt, edgeDockRailBounds, EDGE_DOCK_METRICS` |
| `edgeDock/mask.js` / `macVibrancyMask.js` / `macHaptics.js` / `pointerButtons.js` | 轮廓蒙版 / NSVisualEffectView 裁形 / 触感 / 读主鼠标键 | `rasterizeMask, applyVibrancyMask, performMacHaptic, primaryButtonDown` |
| `edgeDock/preload.js` | dock 专用窄桥 `window.tokenMonitorEdgeDock`（只收 push + 手势，唯一写操作 switchCodexAccount） | — |
| `floatingBubble.js` | 气泡收缩/展开/拖动的纯几何计算 | `collapsedFloatingBubbleBounds, floatingBubbleCollapsePlan` |
| `discordRpc.js` | Discord Rich Presence | `startDiscordRpc, updateDiscordRpc` |

**状态发布与同步**
| 文件 | 职责 | 关键导出 |
|---|---|---|
| `statsPublisher.js` | 发布批量（1s 窗，remote 事件优先）+ renderer 载荷裁剪（去 sessions）+ 快照 stamp | `createStatsPublicationBatcher, rendererStats, createRendererSnapshots` |
| `syncDisplayStats.js` | 同步模式展示合成（Hub 缓存 + 本机记录合并） | `composeLocalSyncStats, composeLocalOnlySummary, completeLocalSyncStats` |
| `syncUploadScheduler.js` | 上传节流（revision 去重、间隔合并） | `createSyncUploadScheduler` |
| `historySource.js` | 本地+Hub 设备历史合并为完整历史 | `resolveCompleteHistory, completeHistorySource` |
| `latestWinsReconciler.js` | 多来源统计竞态合并 | `createLatestWinsReconciler` |
| `deferredWindowSend.js` / `sseEventReader.js` / `syncConnection.js` | renderer 未 ready 补发 / SSE 解析 / 断连分类 | `sendWhenRendererReady, parseSseBlock, classifyStreamFailure` |

**支撑**
| 文件 | 职责 | 关键导出 |
|---|---|---|
| `runtimeConfig.js` | settings 变更分类 → 哪些要重启 usage/limits runtime | `classifySettingsChange, USAGE_STRUCTURAL_KEYS` |
| `deviceRuntimeCoordinator.js` | runtime 替换协调（limits 失效计划、pending refresh 转移） | `settingsLimitInvalidationPlan` |
| `clientSourceIpc.js` | 客户端数据源 IPC（定位/重扫/修锁） | `createClientSourceIpcHandlers` |
| `serviceStatus.js` | 上游 statuspage 健康检查客户端 | `SERVICE_STATUS_PROVIDERS, createServiceStatusClient` |
| `diagnostics.js` / `diagnosticSnapshot.js` / `diagnosticsPanel.js`(renderer) | 诊断报告生成/快照/面板 | `createDiagnosticReportGenerator` |
| `updateInstallQuit.js` | "装更新并退出" guard | `createUpdateInstallQuitGuard` |
| `modelAliasPresentation.js` | 模型别名归一/推断/投影 | `createModelAliasResolver` |
| `linuxAutostart.js` | Linux .desktop 自启 | `setAutostartEnabled` |
| `limits/accountSettings.js` | 主进程侧 limits 账号注册表读取、renderer DTO 投影 | `limitAccountFormsForRenderer, finalAccountSettings` |
| `limits/credentialCommands.js` | 凭证保存唯一路径（normalize→probe→verdict→persist→自动选中） | `createCredentialCommands, credentialVerdict` |
| `limits/fetch.js` | 传输选择：有代理 env → undici outboundFetch，否则 net.fetch | `createElectronLimitsFetch` |
| `limits/statsPresentation.js` | limit 统计展示投影 | `projectLimitStatsForDisplay` |
| `providers/antigravity/oauthLogin.js`、`claude/webFetch.js`、`codex/accountControl.js`、`codex/resetForecast.js`、`workbuddy/localAuth.js` | 各 provider 的 Electron 侧特化逻辑 | — |
| `macWidget/*.js` | Widget 供给管线（见 §6） | `prepareMacWidgetSnapshot, createMacWidgetSnapshotController` |

### 2.3 IPC 通道速查（preload.js ↔ main.js）

preload 暴露 `window.tokenMonitor`（220 行）；edge dock 另有窄桥 `window.tokenMonitorEdgeDock`。

| 分组 | 通道 | main.js 行号≈ |
|---|---|---|
| 设置 | `settings:get`(6735) `settings:update`(6821，约 300 行大 handler) `appearance:*` `subscriptions:*` `pricing:lookup` `app:getInfo` | 6735–7307 |
| 统计 | `stats:get`(7253) `stats:allTimeSessions`(7260) `session:getDetail`(7280) `stream:status` `serviceStatus:get` `codexResetForecast:get` `hub:*`(7295) `export:*` `dashboard:*`(8344) | 7253–8354 |
| 凭证/账号 | `limits:saveCredential/clearCredential`(7454)、`cursor:*`、`opencode:*`、`openrouter:*`、`thirdparty:*`、`codex:*`(8188)、`copilot:*`、`antigravity:*`、`mimo:*` | 7398–8319 |
| 窗口 | `window:minimize/close`、`floatingBubble:*`(7149)、`tray:setIcons`(7226)、`window:viewState`、`window:contentReady`(6328) | 7146–8337 |
| 其他 | tokscale 管理(7410)、appUpdate(7419)、`diagnostics`、clipboard、openExternal、openUserData | 7322–7413 |
| 推送（main→renderer） | `stats:push`(sendPush 4189)、`settings:push`(4779)、`hub:push`、`dashboard:historyChanged`、`tokscale:push`、`appUpdate:push`、`theme:systemUi`、`window:visibility`、`floatingBubble:state` | — |
| Edge Dock（controller.js 691–778） | `edgeDock:ready/click/dragStart/dragEnd/bubbleSize/toggleRateMode/switchCodexAccount/openResetForecastSource/dismiss`；推送 `edgeDock:render` | — |

---

## 3. Renderer UI（src/electron/renderer/）

加载模型：无框架无打包器，`index.html` 底部按依赖顺序 70+ 个 `<script>`，各模块挂 `window.TokenMonitorXxx`；数据靠 `window.tokenMonitor` IPC（推送 + 拉取兜底轮询）。四个窗口表面：主窗（index.html+app.js）、Dashboard 走势窗（dashboard.html+dashboard.js）、Edge Dock（edgeDock/）、浮动气泡（复用 index.html 元素）。

### 3.1 app.js（16349 行）区块地图

约 750 个顶层函数，无 section 横幅注释，按下表定位：

| 行号≈ | 区块 |
|---|---|
| 1–286 | 模块桥接别名（40+ 个 `window.TokenMonitor*`→本地常量）、图标/颜色工具、账户面板错误壳 |
| 287–566 | **`state` 巨型状态对象**(292)、`els` DOM 缓存(353)、手风琴行与全局点击委托 |
| 567–828 | i18n 辅助 `t()`(595)、设置分区手风琴机制、设置摘要文案 |
| 829–1637 | 数字/紧凑格式化、**实时 tok/s 速率**（`observeLiveTokenRate` 1034、`renderTokenRate` 1128）、更新 Pill、**Tokscale 数据引擎维护 UI**(1488–1637) |
| 1638–2029 | **动效引擎**：`animateNumber`(1657)、条形过渡、限额重置动画、趋势条动画（reduced-motion 适配） |
| 2030–2914 | **行渲染核心**：`rowTemplate`(2030)、设备/工具手风琴、`updateRow`(2359)、会话分页器、`renderRows`(2577)、**周期→行数据**（设备/归属/工具/模型/会话/项目 `rowsForPeriod` 2842） |
| 2895–3915 | 订阅（Subscriptions）CRUD UI 与 top-up 条目 |
| 3916–4632 | **Limits 视图**（provider 顺序、tooltip、codex 账户乐观更新、`renderLimits()` 4358）；**服务状态视图** `renderServiceStatus()`(4496) |
| 4633–5015 | 会话详情视图（`openSessionDetail` 4644、`renderSessionDetail` 4683）、趋势视图 `renderTrends()`(4859)、视图判定与设置面板入口 |
| 5016–5494 | Home 历史加载与固定周期（`loadHomeHistory` 5016、`performFixedPeriodHistoryLoad` 5124）、**视图切换器** `renderViewSwitcher`(5377，页脚图标) |
| 5495–6502 | **Home 总览 6 大模块**（限额/模型/工具/会话/设备/趋势 + 活动热力图）、`renderHome()`(6293)、**`render()` 主调度器**(6346) |
| 6503–6741 | 状态栏、`refreshStats`(6606)、`setPeriod`/`setBreakdown`、**`restartTimer`(6734 轮询兜底)** |
| 6742–7694 | 外观设置（布局/字体/玻璃/背景图/**主题色 `applyThemeColors` 6955**/主题码导入导出）、窗口行为与快捷键录制、浮动气泡状态与拖拽 |
| 7695–8220 | Hub/Sync 状态 UI、周期 tabs、**`syncSettingsForm()`(8050，settings→控件全量同步)** |
| 8221–10086 | 偏好列表机制（hidden/pinned/拖拽）、各设置列表渲染（视图/Home/活动/趋势/项目/会话/服务）、**客户端健康面板**(9195–9488)、WSL 面板(9763)、工具偏好(9850) |
| 10087–11029 | 限额 provider 设置（复选框、凭证保存 `saveAccountCredential` 10345）、全部 toggle/move/reorder handler(10633–10924)、**`saveSettings`(10946)/`applyPersistedSettings`(10974)** |
| 11030–11537 | **`init()`(11030)**（订阅推送→getSettings→syncSettingsForm→refreshStats）、主事件绑定区(11126) |
| 11538–12026 | 设置搜索、Edge Dock 设置控件、更新动作、**推送处理**（`onStatsPush` 12105、连接状态、可见性变化） |
| 12171–13349 | **托盘图标 Canvas 绘制**（`renderBarsIcon` 12299、文本排版、自定义项）与**托盘排版编辑器 Tray Composer**(13048–13258) |
| 13350–15282 | 各 provider 账户面板（Codex 13496 / Antigravity 13661 / Mimo 13811 / Copilot 13906 / OpenCode 14214 / OpenRouter 与第三方 14769 / Cursor 15126） |
| 15283–16349 | 模型别名 UI、**自定义单价表单**(15303)、**`setupCursorAccountUI()`(15492，名字有误导性——一站式绑定全部 provider 账户面板)**、启动序列(16341) |

### 3.2 视图/功能模块清单

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `homeOverview.js` | Home 模块纯计算（行、趋势、热力图布局） | `homeModelRows, homeActivityHeatmapLayout, shouldFetchHomeHistory` |
| `homeModulePreferences.js` | Home 模块顺序/隐藏 | `orderedHomeModules, moveHomeModuleOrder` |
| `usageCharts.js` | 全部图表（canvas+SVG）：柱状/K线/热力图/统计卡/火花线 | `dailyBarsChart, candleChart, contribHeatmap, statsCards, modelColor` |
| `usageAttributionRows.js` | 按维度归属行与排名 | `attributionRows, visibleAttributionRows` |
| `modelBreakdownRows.js` | 模型视图三种拆分模式（`mixed` 供应商/模型、`model` 合并、`provider` 按供应商汇总），数据来自 `period.modelProviders`；余量行保证 mixed 行总和=合并总数 | `mixedModelRows, providerSummaryRows, rowsForMode, normalizeModelBreakdownMode` |
| `sessionRows.js` / `sessionDetail.js` / `allTimeSessions.js` | 会话行/详情对话轮/惰性 allTime 会话加载 | `sessionRowsForPeriod, exchangeRows, createAllTimeSessionsLoader` |
| `projectRows.js` / `deviceBreakdown.js` / `toolDetails.js` | 项目行/设备分解/工具展开明细 | `projectRowsForPeriod, deviceBreakdownForPeriod, modelRowsForTool` |
| `limits/windowsView.js`（2445 行） | **Limits 视图 provider 行 DOM 构建器（主窗与 edge dock 共享）** | `createLimitWindowsView` |
| `limits/providerPresentation.js` | 限额窗口标签/新鲜度/能力 tag/来源文案 | `limitProviderCapabilityTags, limitProviderCompactWindows` |
| `limits/accountPanels.js` / `accountShell.js` / `providerOrder.js` / `resetMotion.js` / `displayMode.js` | 凭据面板/外壳/排序/重置动效/填充百分比 | `createCredentialPanel, orderedLimitProviders, limitFillPercent` |
| `accountIdentity.js` | 账户身份（邮箱脱敏、标题、去重） | `maskEmailAddress, dedupeAccounts` |
| `clientDisplayPreferences.js` / `clientHealthPresentation.js` / `clientSourceCache.js` / `clientRescanState.js` / `clientStatusPresentation.js` | 客户端显示偏好/健康聚合/数据源缓存/重扫状态/状态 tag | `orderedClients, clientHealthDetail, createClientSourceCache` |
| `modelAliases.js` / `modelAliasForm.js` / `customPricingForm.js` | 模型别名与自定义单价 | `normalizeModelAliases, upsertOverride` |
| `themePresets.js` | 主题预设、颜色键、主题码（TM1）编解码、vendor 色 | `THEME_PRESETS, THEME_VAR_MAP, encodeThemeCode` |
| `glassRendering.js` / `windowsGlass.js` / `rowIconMasks.js` | 原生材质 class / Win 玻璃 / 行图标 mask | `applyNativeMaterialClasses` |
| `trayBars.js` / `trayComposer.js`（1435 行）/ `trayProviderIcons.js` | 托盘条形几何/**托盘排版编辑器**/provider 图标投递 | `trayBarsLayout, createTrayComposer, trayProviderIconSources` |
| `i18n.js`（8685 行） | **全部翻译内联**：`auto/en/zh-TW/zh-CN/ko/ja`，扁平 key-value `MESSAGES`（en:18、zh-TW:1732、zh-CN:3446、ko:5160、ja:6874 行起） | `translate, applyTranslations, LANGUAGE_OPTIONS` |
| `settingsListFilter.js` / `viewDisplayPreferences.js` / `fixedPeriodRanges.js` / `statsRenderScheduler.js` / `breakdownRenderPolicy.js` | 设置搜索/视图顺序/**固定周期推导**/渲染调度/行渲染策略 | `rangeForSelection, createStatsRenderScheduler, breakdownPage` |
| `tokenRatePresentation.js` | tok/s 速率计算/封顶/衰减 | `tokenRatePerSecond, createLiveTokenRateTracker` |
| `rowDragController.js` / `verticalDragSort.js` / `pressActivation.js` | 行拖拽/垂直排序/按下激活 | `createRowDragController, resolveVerticalDrag` |
| `appUpdatePresentation.js` / `hubBuildPresentation.js` / `diagnosticsPanel.js` / `wslStatusPresentation.js` / `floatingBubbleBoot.js` | 更新展示/Hub 构建展示/诊断面板/WSL 提示/气泡启动参数 | — |
| `edgeDock/dock.js` + `presentation.js` + `items.js` + `shapes.js` | dock 渲染层（只收 `edgeDock:render`，几何在主进程） | `buildEdgeDockCells, toPolygons` |
| `dashboard.js`（814 行） | Dashboard 窗口（Overview 统计卡+热力图；Trends 堆叠柱/K线） | `renderTrends, renderBreakdown, renderActivity` |
| `styles.css`（7373 行，单文件） | 主题=约 37 个 CSS 变量（:root 1–63 行），暗色默认；亮色由 JS（themePresets）改写 RGB 变量实现 | — |

### 3.3 renderer 数据流

推送：`stats:push`（`onStatsPush` 12105 → allTimeSessions.attach → `statsRenderScheduler.request()` 合并重绘 → restartTimer）＋ `settings:push`（→ `syncSettingsForm`）。轮询兜底：`restartTimer`(6734)——流连接时 5min 一次，否则按 `settings.refreshMs`（默认 15s）`refreshStats()`（invoke `stats:get`）。allTime 会话不在常规载荷里，通过 `stats:allTimeSessions` 惰性拉取。

---

## 4. 数据采集管道（src/shared/ 采集侧）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| **`collector.js`**（3441 行） | **采集总引擎**：tokscale 二进制定位/调用/能力探测/定价、本地适配客户端（proma/qodercn）、WSL、watch 根解析、tick 调度、锚点持久化 | `startCollector, collectUsageOnce, collectHistoryOnce, computePeriodWindows, applySessionTimestamps, deriveClientStatus, watchPathsForClients, clientsForWatchPath, tokscaleClientFilter, spawnTokscaleHelp, lookupModelPricing` |
| `watcherHost.js` / `watcherWorker.js` | watcher 跑在 worker 线程（chokidar close() 卡 UI 问题）；worker 崩溃回退本线程；worker 半边唯一持有 chokidar | `createWatcherHost, createWatcherCoordinator` |
| `clientCatalog.js` | **31 个 tracked client 身份唯一事实源**（UMD 纯数据） | `CLIENT_CATALOG, CLIENT_IDS, LOCALLY_PARSED_CLIENT_IDS, CLIENT_LABELS` |
| `clientTracking.js` | 客户端 CSV 兼容层与旧 id 迁移 | `DEFAULT_CLIENTS, normalizeClientsCsv, LEGACY_CLIENT_ID_ALIASES` |
| `clientSources.js` | **每客户端数据目录根的唯一推导**（含 Win 8.3 短路径、copilot exporter、XDG 对齐） | `clientSourceRoots, canonicalWatchPath` |
| `clientSourceObservations.js` / `clientSourceRegistration.js` / `customScanPaths.js` | 根探测/简单根注册/自定义扫描目录（校验+`TOKSCALE_EXTRA_DIRS`） | `clientSourceChecks, normalizeCustomScanPaths, tokscaleExtraDirsEnv` |
| `clientIdentitySplits.js` | 客户端身份拆分（omp 从 pi 拆出）与自动补种 | `CLIENT_IDENTITY_SPLITS, seedSplitClients` |
| `subprocessTermination.js` / `safeStdio.js` / `orderedSink.js` / `abortSignal.js` / `probeDeadline.js` | 子进程两段式终止（SIGTERM→SIGKILL→grace）/EPIPE 静音/按修订号串行 sink/Abort 工具/probe 硬截止 | `createSubprocessTermination, createOrderedSink, runWithProbeDeadline` |
| `anchorSeed.js` / `projectKey.js` / `clientHealth.js` | 冷启动种子（避免首帧全零）/项目 key 归一/健康枚举 | `deviceRecordFromAnchor, canonicalProjectKey` |
| `selfSyncThrottle.js` | 自同步限速单例（常规 5min、源事件 10s 地板）+ `createSourceSyncQueue` | `createSelfSyncThrottle, createSourceSyncQueue` |
| `providers/cursor/selfSync.js`、`providers/antigravity/selfSync.js` | 两个自同步实现（把官方数据搬到 tokscale 缓存目录） | `createCursorSelfSync, createAntigravitySelfSync` |
| `wslUsage.js` | Windows 扫**运行中** WSL 发行版（Lxss 注册表 gate，不启动停着的发行版） | `collectWslUsage, probeWslState` |

**tokscale 配套（6 个 `tokscale*.js`）**：`tokscaleClientMapping.js`（行↔tokscale id 映射/别名展开）、`tokscaleCapabilities.js`（`--help` 解析能力缓存）、`tokscaleConfig.js`（config/home/cache 目录镜像）、`tokscaleCustomPricing.js`（写 `custom-pricing.json`）、`tokscalePlatform.js`（平台包名）、`tokscaleUpdater.js`（npm 查新/下载/sha512/原子落位 + `resetToBundled`）。

**usage/ 运行时分层（src/shared/usage/）**：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `usageRuntime.js` | 把 `startCollector` 包成 usage runtime | `createUsageRuntime` |
| `usageHost.js` / `usageWorker.js` | 采集+transform+归档跑在 worker 线程（`TOKEN_MONITOR_USAGE_WORKER=0` 关）；worker 崩溃回退本进程；单 worker 原则 | `createUsageHost` |
| `usageTransform.js` | 每个 summary 必经：会话归档 capture + `project()` 叠加归档/项目 rollup；设置热更新白名单 `USAGE_TRANSFORM_SETTING_KEYS` | `createUsageTransform` |
| `deviceRuntime.js` | **组装层**：deviceState + usageRuntime + limitsRuntime；`reconfigureUsage` 世代号 fencing、失败回滚 | `createDeviceRuntime` |
| `deviceState.js` | 发布状态机：usage+limits+envelope 合成 record，revision 单调；partial 更新借用上一份字段（`PARTIAL_USAGE_CARRY_FIELDS`） | `createDeviceState` |
| `agentPid.js` | headless agent PID 存活检测（widget/agent 互斥唯一协调点 `data/agent.pid`） | `externalAgentActive` |
| `clientUsageArchive.js` / `sessionUsageArchive.js` / `sessionUsageArchiveStore.js` | 取消跟踪客户端的最后用量投影/会话级归档（JSON 格式）/SQLite 归档存储 | `applyArchivedClientUsage, applySessionUsageArchive, createSessionUsageArchiveStore` |

**Hub 核心用量模型（注意区分）**：`src/shared/usage.js`（单文件，86KB）是 **Hub 端核心模型**——period 归一化、多设备聚合、**`applyPeriodDelta`**(1609)、tokscale JSON 提取、项目 rollup、`normalizeClientName`。与 `usage/` 目录是两回事；`require('./usage')` 解析到该文件，**永远不要加 `usage/index.js`**。

**历史与会话**：`history.js`（tokscale graph 解析/合并，370 天窗口）、`dailyHistoryArchive.js`（每日归档/live-day 升级/重建图）、`localSessions.js`（all-time 会话合并）；会话详情链路：`sessionFiles.js`（找 jsonl）→ `sessionDetail.js`（Claude/Codex JSONL 解析、`groupEvents` 成对话轮、成本分摊）→ `sessionDetailResolver.js`（平台解析 + Windows WSL 回退 + worker 20s 超时）→ `sessionDetailWorker.js`；元数据：`sessionMetadata.js`（tokscale 行补标题/项目/时间戳，按 client 分发到 `providers/<id>/sessionMetadata.js`）；活会话语义：`sessionLive.js` + `sessionContext.js`。

---

## 5. Limits 额度系统与 Provider 集成

### 5.1 Limits 核心框架（src/shared/limits/）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `providers.js`（129 行） | **Provider 目录：身份唯一权威**（UMD 纯数据），28 个有序条目 + client→provider 例外映射 | `LIMIT_PROVIDER_CATALOG, LIMIT_PROVIDER_IDS, limitProviderForClient` |
| `accounts.js` | 注册索引：`registerProvider(account, lazyLoadLimits)`，从 storePath 派生凭证库 schema | `LIMIT_PROVIDER_ACCOUNTS, providerCredentialSettingPaths` |
| `registry.js` | 惰性绑定 account 声明与 limits 模块，产出 fetcher 表（Node-only，不进 Worker） | `LIMIT_PROVIDER_REGISTRY, LIMIT_PROVIDER_FETCHERS` |
| `runtime.js`（960 行） | **LimitsRuntime**：刷新调度（三个定时器：interval/reset+30s/adaptive urgency）、并发闸门（3）、per-provider last-wins lanes、账户 revision、指数退避 | `createLimitsRuntime, DEFAULT_LIMITS_MAX_CONCURRENCY` |
| `collector.js`（355 行） | 分发入口 + 兼容门面：`probeLimitProvider`、间隔白名单归一、物理上限 | `probeLimitProvider, normalizeLimitsRefreshMs, normalizeLimitsRefreshMode` |
| `core.js`（1073 行） | 线上 schema 归一化与跨设备聚合；`publicLimits`（去身份）/`syncLimits` | `normalizeLimitProvider, normalizeLimitWindow, aggregateLimits` |
| `burnRate.js` | 自适应刷新控制律（ttl = remaining%/burnRate/4，60s 下限，5min 基线） | `createLimitsBurnState, nextLimitsUrgencyRefresh` |
| `resetBoundary.js` / `retryPolicy.js` / `providerHelpers.js` | reset 时刻+30s 探测/退避+retry-after/共享 fetch 工具 | `computeRetryDelayMs, fetchJson, runProcessText, TOKEN_MONITOR_USER_AGENT` |
| `windowLabels.js` / `windowText.js` / `balanceDisplay.js` | 窗口显示名/主值副行文案/**余额 credits 显示唯一入口**（UMD，托盘和 Widget 也用） | `limitWindowLabel, limitWindowText, isCreditsWindow, creditsMeterPercent` |

**一次 limits 刷新生命周期**（runtime.js）：`refresh(scope, reason)` → `queueScope`（last-wins：account revision/epoch 递增，abort 同 key active；冷却 bypass 白名单 `COOLDOWN_BYPASS_REASONS`）→ `pump()` 并发闸门 → `dispatchIntent`（`resolveConfigSnapshot` → registry fetcher → `runWithProbeDeadline` 物理 120s）→ `commitRows`（epoch/revision 门禁 → `normalizeLimitProvider` → lastGood/transient 保留）→ 退避 `applyRetryPolicy` → `rebuildSnapshot` 发布。**注意雷区**：本地 token 用量永远不触发 limits 刷新；`burn-rate` 永不进 bypass 白名单。

### 5.2 Provider 集成（src/shared/providers/，28 个 limits provider + 6 个用量侧目录）

**Limits provider 清单**（catalog 顺序 = 新装默认顺序）：`claude, codex, opencode, cursor, antigravity, cline, factory, kimi, grok, copilot, zed, commandcode, mimo, zai, zaiteam, kiro, workbuddy, qoder, deepseek, devin, typesafe, openrouter, minimax, volcengine, ollama, trae, alibaba, thirdparty`。

仅用量侧目录（无 account/limits）：`droid`（→factory）、`dsh`（→deepseek）、`hermes`、`proma`、`qodercn`（→qoder）、`reasonix`；client `zcode` → provider `zai`（`zai/zcodeDiscovery.js`）。

**标准模式**（读 claude/、codex/、cursor/ 三个样例即可举一反三）：
- `account.js`：**零 require 叶子模块**，声明 `id`、`fetch`（limits.js 导出名）、`fields[]`（settings key、kind、**storePath**、normalize、envFallback、persist）、可选 `status/form/urlPolicy/discover/envProbe`。
- `limits.js`：导出 `fetchXxxLimits(options, deps)`，**必须用注入的 `deps.fetch`**；返回 `normalizeLimitProvider` 兼容对象（windows[]/balance/status）；错误用 status ∈ ok/disabled/notConfigured/unauthorized/rateLimited/unavailable/error。
- 取数机制速查：claude=Web cookie→本地 OAuth→CLI 三层回退；codex=OAuth(`~/.codex/auth.json`)+CLI JSON-RPC；cursor=node:https 直连四端点+tokscale 凭证；copilot=GitHub Device Flow；opencode=Web API+本地 SQLite+Go ledger 三源；volcengine=**arkcli CLI**；kiro=CLI ANSI 解析；grok=CLI JSON-RPC+gRPC-web 回退；deepseek/zai/minimax/trae/cline/devin/commandcode/openrouter/mimo/qoder/zed/typesafe/workbuddy/alibaba/ollama=各自 HTTP API 或页面 cookie；thirdparty=自定义 baseUrl 适配器；factory=本地凭证文件+API。

**凭证体系**：`credentialStore.js`（**明文** JSON `<userData>/credentials.json`，0600/Windows 靠 ACL，O_NOFOLLOW，原子写，settings↔credentials 双提交；schema 完全由 account.js 的 storePath 派生，**新增 provider 永不改此文件**）→ `hashKey.js`/`namedProfile.js`（身份哈希/profile 名）→ 主进程绑定 `electron/limits/accountSettings.js`（renderer DTO 只含表单元数据，**凭证默认脱敏**）+ `credentialCommands.js`（保存=normalize→probe→verdict→persist，probe 用 draft-only 凭证）。

**传输层**：`outboundFetch.js`（undici EnvHttpProxyAgent，无效代理 fail-closed）+ `electron/limits/fetch.js`（有代理 env 用前者，否则 Chromium net.fetch 走 OS 代理）。Chromium 雷区：不发 `Host` 头、`credentials:'omit'`、跨域带路径 Referer 会被取消。

### 5.3 新增一个 provider 完整 checklist

1. `src/shared/providers/<id>/account.js`（零 require 叶子，声明字段与 storePath）
2. `src/shared/providers/<id>/limits.js`（`fetchXxxLimits`，用注入 fetch）
3. `src/shared/limits/accounts.js` 加一行 `registerProvider(...)`
4. `src/shared/limits/providers.js` 的 `LIMIT_PROVIDER_CATALOG` 加条目（改顺序/改名会动 Hub build marker → 跑 `npm run update:hub-build`）
5. 展示层：`vendorPresentation.js`、`renderer/limits/providerPresentation.js`、i18n 各语言 `settings.<id>.*`、图标
6. 文档：有非显然边界时加 `docs/providers/<id>.md`；README 支持表；`.env.example`
7. 测试：`tests/shared/<id>Limits.test.js`
8. `npm run verify` + `npm run update:hub-build`

---

## 6. Hub / Agent / Worker / 多设备同步

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/agent/agent.js`（210 行） | 无头 agent CLI：args/env 解析（`TOKEN_MONITOR_HUB_URL/SECRET`）、PID 文件与 widget 互斥、`--once`/`--dry-run` | `runAgent, runAgentOnce`（在 `runtime.js`） |
| `src/agent/runtime.js` | `createDeviceRuntime` + orderedSink（sink.send=POST `/api/ingest`） | `runAgent, runAgentOnce` |
| `src/agent/seedClients.js` | agent 版 client 拆分补种持久化 | `seedAgentClients` |
| `src/hub/server.js`（395 行） | Node Hub：`createHub()` 传输无关（HTTP 与进程内双通道）；数据 `data/devices.json`；SSE 100ms 合并+内容键去重；订阅 409 乐观并发；无 secret 强制绑 loopback | `createHub` |
| `worker/src/index.js`（407 行） | Worker Hub：单实例 Durable Object `HubDO`；DO storage；SHA-256 摘要常时比较鉴权；特有 `GET /api/public/stats` 与 `?secret=` iOS 兼容 | `default, HubDO, publicPeriods` |
| `src/shared/hubProtocol.js` | 协议协商头（minimal/stream v2/freshness）+ `hubStatsContentKey` | `HUB_RESPONSE_MINIMAL, hubStatsContentKey, freshnessEvent` |
| `src/shared/syncPayload.js` | 上行 payload 裁剪与 1MiB 预算阶梯降级；`postSyncPayload` 413 自动降级重试 | `syncPayload, postSyncPayload, SYNC_PAYLOAD_BUDGET_BYTES` |
| `src/shared/hubBuildIdentity.js` / `hubBuildRegistry.json` / `hubBuildComparison.js` | Hub 部署身份（registry 哈希，不是产品版本）/注册表/客户端比较 | `currentHubBuild, compareHubBuild` |
| `src/shared/syncUploadInterval.js` | 上传间隔常量与 staleness 换算（间隔>0 时 hub staleness ≥ 2×间隔） | `SYNC_UPLOAD_INTERVAL_OPTIONS, staleAfterMsForSyncUpload` |
| `src/shared/subscriptionDisplay.js` | 共享订阅文档：`updatedAt` 兼任乐观并发 token 且严格递增；`isStaleSubscriptionWrite` | `emptySubscriptionDocument, subscriptionDocument, isStaleSubscriptionWrite` |
| `src/shared/subscriptionText.js` | 订阅记录统一措辞（UMD） | `amountText, cadenceText, priceText` |

**Hub 端点表**（Node 与 Worker 同构）：

| 端点 | 鉴权 | Node 位置 | Worker 位置 |
|---|---|---|---|
| `GET /api/health`（+hubBuild） | 无 | server.js:243 | index.js:233 |
| `GET /api/stats`（聚合+subscriptionsUpdatedAt） | secret | :258 | :270 |
| `GET /api/devices` / `GET /api/history` | secret | :259 / :260 | :274 / :279 |
| `GET /api/stats/stream`（SSE v2） | secret | :262 | :284 |
| `POST /api/ingest`（1MiB 上限） | secret | :289（核心 `ingest()` :157） | :308 |
| `GET/PUT /api/subscriptions`（409 stale_write） | secret | :307 / :311 | :334 / :338 |
| `DELETE /api/devices/:id` | secret | :331 | :378 |
| `GET /api/public/stats`（脱敏，opt-in） | 无 | **无此端点** | :247 |

**三种 hubMode 数据流差异**（实现在 main.js：`normalizeHubMode` 1928、`effectiveHubConfig` 3146、`startEmbeddedHub` 3189、`postToHub` 3248、`startStatsStream` 4466、`startHostCollector` 5577、`startSyncCollector` 5534、`startMode` 5492）：
- **local**：collector → 进程内聚合；订阅以 settings.json 为权威，不调 hub 端点。
- **client**：sink → `syncUploadScheduler` → POST ingest；同时 SSE `/api/stats/stream` 收远端；展示=Hub 缓存+本机合成（`composeLocalSyncStats`）；订阅以 hub 为权威（409 时 re-base）。
- **host**：sink → **进程内直调** `embeddedHub.hub.ingest()`（不走 loopback）；展示=进程内 `onStats()` 订阅；别的设备 HTTP 连进来；绑定失败回退 local。

**改 Hub/wire 的流程**：改 `src/hub/server.js` 路由 + `worker/src/index.js` `HubDO.fetch()` 同构分支 → 共享纯函数改 `src/shared/` 后 `npm run sync:worker` → `npm run update:hub-build` → 更新 `docs/API.md` 与两侧测试。wire shape 兼容性铁律：新字段必须决定"旧 hub 面前如何降级"；advisory 头（minimal/stream v2）是可协商的；能力标记缺失≠true；新敏感字段要同步加进 Worker `publicLimits`/`publicPeriods` 脱敏。

**Worker 自托管部署**：`cd worker/ && npm install && npx wrangler secret put TOKEN_MONITOR_SECRET && npm run deploy`（`wrangler.toml`：DO binding `HUB`、`v1 new_sqlite_classes`、可选 `PUBLIC_STATS_ENABLED=1`）。部署前若改过 shared 必须先在根目录 `npm run sync:worker`。

---

## 7. macOS 原生 Widget（native/macos/ + macWidget 桥接）

桥接机制：**App Group 容器内文件快照 + mtime 需求信号**。Electron 侧写 `snapshot.json`（schema v10），Swift 侧 TimelineProvider 读；Widget 在屏时写 demand marker（零内容、只更新 mtime），Electron 轮询 mtime 决定是否做快照工作；刷新靠 Reloader CLI（`scripts/TokenMonitorWidgetReloader.swift`：`LSRegisterURL` 注册宿主 + `WidgetCenter.reloadTimelines`）。

| Swift 文件 | 职责 |
|---|---|
| `TokenMonitorWidgetBundle.swift` | @main，声明 5 个 widget |
| `TokenMonitorWidget.swift` | widget 定义（kind/AppGroup 从 Info.plist 读） |
| `WidgetTimelineProvider.swift` | TimelineProvider：加载快照、touch demand marker |
| `WidgetSnapshot.swift` | 快照数据模型（schemaVersion=10，20 分钟过期判定） |
| `WidgetDashboardViews.swift` / `WidgetActivityViews.swift` / `WidgetViewModel.swift` | 大号数字/配额行/趋势图 / 活动热力图 / L10n 与设计令牌 |
| `WidgetDemandMarker.swift` | demand marker 文件名常量 |
| `WidgetConfigurationIntent.swift` | AppIntents（页面/维度/日期选择） |

Electron 侧：`src/shared/macWidgetSnapshot.js`（快照构建/指纹/`MAC_WIDGET_SCHEMA_VERSION`）、`src/shared/macWidgetConfig.js`（App Group 校验）、`src/electron/macWidget/*`（bridge/demand/history/snapshotController/reloader/`macAppGroupContainer.js` 用 koffi 调 NSFileManager 拿容器路径）。构建：`npm run build:mac-widget`（xcodebuild，`WIDGET_UI_VERSION=47`/`WIDGET_SCHEMA_VERSION=10`）；打包签名链见 `scripts/macos-packaging.js` + `native/macos/README.md`。

---

## 8. 构建发布 / 官网 / 测试 / 文档

### 8.1 scripts/ 关键脚本

| 脚本 | 作用 |
|---|---|
| `ensure-vendored-tokscale.js` + `vendoredTokscale.js` + `vendor/tokscale.json` | tokscale vendored：pin 清单（fork `Javis603/tokscale` commit `ab1067f3`，`baseVersion` 必须等于 npm 依赖版本，9 平台 sha256）→ 下载→sha256→冒烟→原子覆盖 `node_modules/@tokscale/cli-*/bin/`。**只有 app/agent/打包入口会跑它**；install/hub/lint/test 永不下载 |
| `verify-vendored-tokscale{,-clients,-release}.js` | 三道发布门禁：DSH fixture 端到端语义 / 客户端清单 vs `--help` / 清单与 optionalDependencies 全量资产核对 |
| `electron-builder.config.js` | 薄壳，配置主体在 `package.json` 的 `build` 字段（mac dmg+zip forceCodeSigning、win nsis+portable、linux AppImage、asarUnpack tokscale/koffi） |
| `nsis-installer.nsh` | per-user 安装 + icacls 给 LPAC 授权（修复 AppContainer 白窗 #487） |
| `macos-packaging.js` / `macos-provisioning.js` / `sign-macos-with-widget.js` / `build-macos-widget.js` / `verify-macos-widget-app.js` | mac 打包链（appex 进 PlugIns、profile 校验、osx-sign 钩子、产物校验） |
| `hub-build-manifest.js` / `sync-worker-shared.js` / `update-hub-build.js` | `WORKER_SHARED_MODULES`（14 个模块）闭包清单 / `npm run sync:worker`（生成 `worker/src/shared/`，CI 查 drift）/ `npm run update:hub-build`（重算 registry 哈希） |
| `signpath-windows-artifacts.js` / `merge-mac-updater-metadata.js` / `prepare-github-release-notes.js` / `verify-updater-artifact-names.js` | Windows SignPath 签名+blockmap 重建 / mac 更新元数据合并 arm64+x64 / release notes 生成 / 产物名校验 |
| `benchmark-hub-bandwidth.js` | node 与 worker 两份共享实现的 SSE 字节对比 |

### 8.2 CI 门禁（.github/workflows/）

| workflow | 作用 |
|---|---|
| `ci.yml` | lint+test（Linux Node 22/24 + mac/win Node 24 + 多时区 job）；**Linux 上 worker drift 门禁**（sync 后 `git diff --exit-code worker/src/shared`） |
| `vendor-tokscale.yml` | vendored tokscale 三道门禁（4 个打包目标 runner） |
| `release.yml` | `v*` tag → 四平台矩阵构建签名（mac 公证 / win SignPath）→ 发布 |
| `codeql.yml` / `pages.yml` / `star-history.yml` | 安全扫描 / 官网部署（site/** 触发）/ star 历史 |

### 8.3 官网 site/

独立 React 19 + esbuild 静态站（独立 package.json，与主应用不共享代码）：`build.mjs`（输出 `../_site/`）、`index.html`、`scripts/islands.jsx`（React 岛屿+WebGL）、`darkVeil.jsx`（着色器背景）、`main.js`、`i18n.js`（en/zh-TW/zh-CN）。部署 GitHub Pages（pages.yml）。

### 8.4 测试体系（tests/，~364 个文件）

- 运行：`npm test` = `node --test "tests/**/*.test.js"`；单个：`node --test tests/shared/collector.test.js`；lint+test 一次跑 `npm run verify`。
- 分布：shared/ 183、electron/ 168、scripts/ 4、worker/ 4、agent/ 2、docs/ 2、hub/ 1。
- 命名规律：与源文件对应（`src/shared/abortSignal.js` → `tests/shared/abortSignal.test.js`）；同 provider 聚合（`codexAuth.test.js`）；元测试锁文档（`tests/docs/readmeConsistency.test.js`、`providerGuidance.test.js`）。
- 常用 helpers：`tests/helpers/watchHost.js`（把 watcher 固定进程内，`TOKEN_MONITOR_WATCH_IN_PROCESS`）、`sourceEnv.js`（清空 HOME/XDG 等源 env）、`localTime.js`（本地日历分量构造时间戳，防时区漂移）、`referencedTerminationTimers.js`（防 Node22 unref 提前退出）、`rendererStyles.js`（拼 styles.css 供 url() 断言）。

### 8.5 docs/ 文档索引

`architecture.md`（跨运行体契约，**改共享边界前必读**）、`API.md`（Hub 端点与 wire shape）、`configuration.md`（GUI vs CLI/env 优先级）、`export.md`（CSV+JSON 导出）、`privacy.md`、`code-signing.md`、`github-copilot-otel.md`（Copilot otel exporter 启用）、`wsl-sqlite-setup.md`（+中文版）、`USAGE-INTERFACES.zh-CN.md`（**客户端用量检测接口集成文档**：tokscale 契约、自研解析约定、32 客户端数据源明细、迁移清单）、`providers/README.md`（provider 笔记路由与两份注册清单）+ 19 篇 provider 专门笔记（claude、codex、cursor、antigravity、opencode、volcengine 等）。

---

## 9. 常见修改任务速查

| 我想… | 去哪改 |
|---|---|
| 改窗口行为/置顶/气泡 | `windowBehavior.js`（profile）+ `main.js createWindow`(6349) + `floatingBubble.js`（几何）+ `windowState.js` |
| 加新 IPC 通道 | `src/electron/preload.js`（API）→ `main.js` IPC 区(6735–8353) → 需要的话 `settingsForRenderer()`(4674) + `readSettings`(2366) normalize 链 |
| 改托盘显示/排版 | `tray.js`（`buildTrayIcon`/`buildTrayMenuTemplate`）+ `src/shared/trayText.js`/`trayLayout.js`（schema v3）+ renderer `trayComposer.js` + app.js 12299–13258 |
| 改 Edge Dock | 主进程接线 `main.js` 4798–5169 + `edgeDock/geometry.js`（几何/命中）+ `edgeDock/controller.js`（窗口/IPC）+ renderer `edgeDock/*`（外观 `shapes.js`） |
| 加新视图（breakdown 维度） | app.js: `VIEW_DISPLAY_OPTIONS`(229)+`viewBreakdownValues`(241)+`VIEW_ICON_CLASSES`(252) → `icons/views/<id>.svg` + `styles.css` mask 规则(5451) → `index.html` 容器 + `els`(353) → `render()` 分支(6346) 或 `rowsForPeriod()`(2842) → i18n `views.<id>` |
| 加新设置项 | `index.html` 对应 section（带 data-i18n）→ app.js `els`(353)+`syncSettingsForm`(8050)+绑定区(11126)+`saveSettings`(10946) → `readSettings`/`defaultSettings`(main.js 2366/525) → i18n |
| 加 i18n 翻译 | `renderer/i18n.js` 五个语言块加同一扁平 key；HTML 用 `data-i18n*`，JS 用 `t()`(app.js:595) |
| 改主题色 | 默认值 `styles.css :root`(1–63) + `themePresets.js`(THEME_VAR_MAP，两者必须一致) + `applyThemeColors`(app.js:6955) |
| 改图表 | `usageCharts.js`（主窗/趋势/dashboard 共用） |
| 改模型视图拆分方式 | 数据：`usage.js` 的 `period.modelProviders`（`addUsageRowToPeriod` 累加、`normalizePeriod`/`addPeriodInto`/`applyPeriodDelta` 全链路已支持）；行构建：`renderer/modelBreakdownRows.js`；模式开关：settings `modelBreakdownMode`（main.js `normalizeModelBreakdownMode` + app.js `modelRowsForPeriod` + index.html `modelBreakdownModeHost`）；别名折叠：`modelAliasPresentation.js` 的 `foldModelProviderMap` |
| 支持新客户端的数据目录 | `clientCatalog.js`（身份）→ `clientSources.js::clientSourceRoots`（根目录）→ 需要则 `collector.js` 本地解析分支（参照 proma/qodercn）+ `watchPolicyEntries` watch 修剪 → 可选 `sessionDetail.js`/`sessionMetadata.js` → README/图标/`clientHealth.js` check id 清单 |
| 改扫描频率/防抖 | `collector.js`：watch 防抖(2467，≥1500ms)、`watcherOptions`(2413 轮询间隔)、定时 tick(2468)、`FULL_SCAN_INTERVAL_MS`(2366,1h)、历史间隔(991)；env：`TOKEN_MONITOR_WATCH_DEBOUNCE_MS/INTERVAL_MS/WATCH_POLLING` |
| 改用量统计口径/加时段 | `usage.js` `PERIODS`(3) + `applyPeriodDelta`(1609) + `collector.js collectUsageOnce` + `deviceState.js PARTIAL_USAGE_CARRY_FIELDS` + `computePeriodWindows`(909) + 展示层 |
| 改 session 详情解析 | `sessionFiles.js` → `sessionDetail.js`（parseClaudeTranscript/parseCodexTranscript/groupEvents）→ `sessionDetailResolver.js`（WSL 回退/worker） |
| 加 limits provider | 见 §5.3 八步 checklist |
| 给 provider 加额度窗口 | `providers/<id>/limits.js` 窗口构建 → `limits/core.js`（排序特例）→ `limits/windowLabels.js`/`windowText.js`（显示） |
| 改余额/credits 显示 | `limits/balanceDisplay.js`（唯一显示入口，key 是 `windows[].metric==='credits'`，禁止 provider 白名单）+ `core.js normalizeProviderBalance` |
| 改刷新间隔/自适应 | `limits/collector.js` 间隔白名单 + `limits/burnRate.js`（自适应控制律）+ `main.js` 625/6977（env/settings）+ `limits/retryPolicy.js` |
| 改凭证/表单 | `providers/<id>/account.js`（字段声明）+ `electron/limits/accountSettings.js`（写路径/投影）+ `credentialCommands.js`（保存探针） |
| 加 Hub 端点 | `hub/server.js` + `worker/src/index.js` 同构分支 → `npm run sync:worker` → `npm run update:hub-build` → `docs/API.md` |
| 改上传 payload | `src/shared/syncPayload.js`（裁剪阶梯/预算） |
| 改托盘/Widget/edge dock 共享文案 | 注意 `limits/windowLabels.js`/`windowText.js`/`balanceDisplay.js` 和 `subscriptionText.js` 都是 UMD 共享——改一处三处生效，且 display 层绝不写回线上数据 |
| 改 mac Widget 显示 | Swift：`native/macos/TokenMonitorWidget/*`；数据：`src/shared/macWidgetSnapshot.js`；改 schema 记得同步 `WIDGET_SCHEMA_VERSION` 与 `WidgetSnapshotDecodingTests.swift` |
| 打 Windows 安装包 | `npm run dist:win`（NSIS+portable → dist/）；本地无签名，正式签名在 CI SignPath |
| 改 tokscale 版本 | `package.json` 依赖 + `scripts/vendor/tokscale.json`（或 `mode:"upstream"`）→ `npm ci` → 三道门禁联动 |

---

## 10. 雷区（改代码前必读，源自 AGENTS.md Tripwires）

1. **Worker 隔离**：`worker/` 不能 import 上级；只改 `src/shared/` 再 `npm run sync:worker`；闭包内模块禁用 Node built-ins。CI 查 drift。
2. **Hub build marker**：Hub/shared 最终改动后跑一次 `npm run update:hub-build`；`limits/providers.js` 在 Hub 核心里，加/删/改名 provider 都会移动 marker。
3. **tokscale 二进制**：只有 app/agent/打包入口跑 `ensure:tokscale`；install/hub/lint/test/verify 永不下载。
4. **串行扫描、精确增量**：全量 tick 串行扫 today/month/allTime；watch tick 只扫 `--today` + `applyPeriodDelta` 恒等增量。禁止并行化或改成估算。
5. **无 watch 冷却**：产品承诺 3–5s 更新；防抖重臂不排队；不 watch 自同步缓存目录（会无限自触发）。
6. **client id 是分区键**：id 必须是 `normalizeClientName()` 不动点；别名必须归回父 id；filter 永不产出 `synthetic`。
7. **limits 刷新触发**：本地用量永不触发 limits 刷新；`burn-rate` 不进 `COOLDOWN_BYPASS_REASONS`。
8. **Electron 传输**：provider 调用走注入 transport；Chromium 下不发 `Host` 头、`credentials:'omit'`、跨域 Referer 带路径会被取消。
9. **凭证留在主进程**：renderer 默认脱敏；新凭证在 provider `account.js` 声明 `storePath`（`CREDENTIAL_SETTING_PATHS` 派生），**永不**在 `credentialStore.js` 加字面条目、**永不**建 provider 专属 store；limits account 叶子必须零 require。
10. **公开统计保持公开口径**：订阅版本戳由 `statsWithSubscriptionVersion()` 只在鉴权路径添加；并进 `getStats()` 会从 Worker 无鉴权 `/api/public/stats` 泄漏。
11. **余额显示**：以 `windows[].metric==='credits'` 为标记走 `limits/balanceDisplay.js`，禁止 provider 白名单；展示推导的百分比不进 wire shape。
12. **兼容面**：settings key、env、CLI flag、Hub 端点、wire shape 都有外部用户，变更按 breaking 处理并规划迁移。
13. **发布快照不可变**：`electronPresentationStats()`/`composeLocalSyncStats()` 按对象缓存投影——原地修改会拿到陈旧投影，必须换新对象。
14. **usage.js 与 usage/ 目录**：`require('./usage')` 解析单文件（Hub 核心模型）；永不添加 `usage/index.js`。`limits/` 同理没有 index.js（Worker ESM 直引 core.js）。

---

## 11. 命令速查

```bash
npm start            # 启动 Electron widget（= widget/dev；先 ensure:tokscale）
npm run hub          # Node Hub，端口 17321
npm run agent        # 无头采集器（agent:once 单次；--dry-run 不发送）
npm test             # node:test 全量；node --test tests/shared/xxx.test.js 单个
npm run lint         # ESLint flat config
npm run verify       # lint + test（唯一本地验证入口）
npm run sync:worker  # 同步 src/shared → worker/src/shared（改共享代码后必跑）
npm run update:hub-build  # 重算 Hub 构建身份 registry（Hub/shared 改动定稿后必跑）
npm run dist:win     # Windows NSIS+portable → dist/
npm run pack / dist:mac / dist:linux   # 其他平台
npm run build:mac-widget / dev:mac-widget  # macOS 原生 Widget
```

Node ≥ 22.15（zstd 解码依赖）；配置模板 `.env.example`（69 个变量：HUB/采集开关/limits/各 provider 凭证/代理，详见该文件注释）。

---

## 12. 排查数据问题的标准路径

1. **数据不对/不更新** → 先看诊断面板（renderer `diagnosticsPanel.js`，生成报告 `electron/diagnostics.js` + `diagnosticSnapshot.js`）。
2. **tokscale 层**：`main.js` 5784–5871 的状态/重置、`tokscaleUpdater.js`、vendored 门禁脚本。
3. **采集层**：`collector.js` 的 diagnostic 事件（`collector-tick-failed`、`watcher-polling-fallback`、`subprocess-termination-unconfirmed` 等，见各 emit 处）→ `diagnosticJournal.js`。
4. **客户端来源**：设置里的客户端健康面板（app.js 9195–9488）↔ `clientSourceObservations.js` 的 checks ↔ IPC `usage:clientSources`（`clientSourceIpc.js`）。
5. **同步问题**：client 模式看 `syncConnection.js` 断连分类 + SSE 日志；host 模式看 `startEmbeddedHub` 绑定；上传看 `syncUploadScheduler` revision 链。
