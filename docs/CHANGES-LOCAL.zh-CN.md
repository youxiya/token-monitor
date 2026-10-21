# 本地修改记录（Local Modifications）

> 基线：上游 `ce26462f`（token-monitor v0.76.0）。全部修改已提交至自用 fork `youxiya/token-monitor`（`origin`=自用 fork，`upstream`=上游 Javis603；上游更新时 `git fetch upstream` 后 `git rebase upstream/main`）。
> 首次记录：2026-09-29（基线 `052667e` / v0.63.1）。最近更新：2026-10-21（rebase 到 v0.76.0，见第十节；Windows 打包脚本入库，见第十一节）。
> 机器可回放补丁：[`docs/CHANGES-LOCAL.patch`](CHANGES-LOCAL.patch)（供应用到**上游干净基线**；`git apply` 应用，`git apply -R` 撤销）。
> 项目导航文档：[`docs/PROJECT_MAP.zh-CN.md`](PROJECT_MAP.zh-CN.md)。

---

## 一、功能：模型视图按供应商拆分用量

### 背景与根因

使用 dsh（DeepSeek Harness）时，同一模型经由不同供应商路由（router / router9 / kala / uuapi）的用量被合并显示，即使"模型别名-自动合并"是关闭的。

排查结论：**不是别名系统的问题**。tokscale 扫描 dsh 时上报的模型是"服务端实际模型"（served model，如 `deepseek-v4.1-flash`），路由来源是行内一个独立的 `provider` 字段（tokscale fork 的 dsh.rs 同时携带两者）。token-monitor 的 period 聚合（`addUsageRowToPeriod`）只用 model 做键，导致四个供应商的同一模型合并成一行。

GitHub 调研：无可利用的分支/PR——Javis603/tokscale fork 只有 main 且 pinned commit（`ab1067f3`）即最新；token-monitor 的 100 个 fork 中无此功能实现；相关 issue（#777 等）只报模型归属错误。参照 `dsh-all-usage` 插件（`E:\token\dsh-all-usage`）的"混合查看 / 按模型 / 按供应商"三视图设计实现。

### 设计

period 新增 `modelProviders` 嵌套 map：`{ [model]: { [provider]: { tokens, costUsd, cacheReadTokens, cacheWriteTokens, outputTokens } } }`。

- 数据来源：tokscale 行的 `row.provider`（经 `normalizeProviderName` 归一），只在 tokens > 0 时累加；
- 增量机制：复用 `applyPeriodDelta` 的通用递归（数值叶子自动 `base+fresh-anchor`），锚点快照随 period 一起持久化；
- 兼容性：旧 Hub 会剥掉未知字段 → 视图自动回退为合并行，不报错；`wire shape` 为纯新增字段；
- 归档回填：归档会话只带 `session.providers`（无 per-model-provider），mixed 视图用"余量行"兜底，保证任何模式下行总和精确等于 `period.models` 合并值；
- cursor 特例：`reconcileCursorAutoGlobalModels` 把 `default` 重键为 `cursor-auto` 时同步迁移 provider 拆分（exclusive 迁移、partial 丢弃回退合并行）；
- 别名兼容：模型别名折叠新增 `foldModelProviderMap`，按"别名组 × 供应商"合并。

### 视图行为（新设置项 `modelBreakdownMode`）

| 模式 | 行为 | 默认 |
|---|---|---|
| `mixed`（供应商 / 模型） | 每个路由一行，名称 `provider / model`；无路由条目的模型保持原样；余量单独成行 | **是（默认）** |
| `model`（按模型） | 原有合并行为，完全不变 | — |
| `provider`（按供应商） | 跨模型按供应商汇总 + 一行未归属余量 | — |

UI：Models 视图顶部的三段切换按钮；i18n 五语言（en / zh-TW / zh-CN / ko / ja）齐全。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src/shared/usage.js` | `emptyPeriod` 加 `modelProviders`；`addUsageRowToPeriod` 累加；`normalizePeriod` 归一化（兼容 `model_providers` snake_case）；`addPeriodInto` 合并；`reconcileCursorAutoGlobalModels` cursor-auto 重键迁移 |
| `src/electron/modelAliasPresentation.js` | `foldModelProviderMap` + 注册进 `USAGE_PROJECTIONS` |
| `src/electron/renderer/modelBreakdownRows.js` | **新增**：三模式行构建（UMD 模块，可独立单测） |
| `src/electron/renderer/app.js` | API 桥接、`modelRowsForPeriod` 三模式分发、`syncModelBreakdownModeControls`、render() 显隐、点击绑定、els 条目 |
| `src/electron/renderer/index.html` | `modelBreakdownModeHost` 按钮组 + `<script>` 引入 |
| `src/electron/renderer/styles.css` | `.model-breakdown-mode-*` 样式（沿用 tool-detail-footer 视觉） |
| `src/electron/renderer/i18n.js` | `views.modelBreakdownMode` / `views.modelBreakdown.{mixed,model,provider}` × 5 语言 |
| `src/electron/main.js` | `normalizeModelBreakdownMode` + `defaultSettings` + `readSettings` 归一 + `settings:update` 白名单 |
| `worker/src/shared/usage.js` | `npm run sync:worker` 生成的同步副本（@generated） |

## 二、上游测试修复（本机 Windows 环境泄漏 / 权限问题）

这些失败与功能改动无关，是上游测试在真实开发机上的既有问题（CI 提权环境不复现）：

| 文件 | 问题 | 修复 |
|---|---|---|
| `tests/helpers/sourceEnv.js` | guard 漏清 `APPDATA`/`LOCALAPPDATA`，真实 VS Code Copilot 数据泄漏进 presence 断言 | 加入 `SOURCE_ENV_KEYS` |
| `tests/helpers/sourceEnv.js` | guard 漏清 `DSH_HOME`，真实 `~/.dsh` 会话树泄漏进所有 DSH 夹具（9.4 节） | 加入 `SOURCE_ENV_KEYS` |
| `tests/shared/clientStatus.test.js` | antigravity presence 探测读到真实 tokscale antigravity-cache | 测试内隔离 `TOKSCALE_CONFIG_DIR` |
| `tests/shared/customScanPaths.test.js` | Windows 无管理员权限时目录 symlink EPERM | win32 改用 junction |
| `tests/electron/macWidgetLaunchServicesRecovery.test.js` | 文件 symlink EPERM（junction 只支持目录） | win32 无权限时跳过 helper 子场景（macOS 与提权 CI 仍覆盖） |
| `tests/shared/collectorSessionTimestamps.test.js`、`collectorTriStatePropagation.test.js`、`dshSessionFiles.test.js` | 未安装 source env guard | 各自 `installSourceEnvGuard(test)` |

## 三、文档

| 文件 | 内容 |
|---|---|
| `docs/PROJECT_MAP.zh-CN.md` | **新增**：全项目"功能 → 文件"导航地图（子系统区块图、IPC 速查、修改任务速查、雷区），供 AI/人减少重复通读 |
| `docs/USAGE-INTERFACES.zh-CN.md` | **新增**：客户端模型用量检测接口集成文档（两条集成路线、tokscale CLI 契约、自研解析约定、32 个客户端数据源明细、迁移检查清单），用于迁移到其他项目或从零开发 |
| `AGENTS.md` | 路由表首行加入 PROJECT_MAP 入口 |
| `docs/CHANGES-LOCAL.zh-CN.md` | 本记录 |
| `docs/CHANGES-LOCAL.patch` | 全部代码修改的机器可回放补丁（20 文件，+1315/−16） |

## 四、环境修复（不属于代码，留档备查）

> 完整的网络工具栈说明、故障决策树、诊断命令与还原方法，见 [`docs/NETWORK-SETUP.zh-CN.md`](NETWORK-SETUP.zh-CN.md)。以下为摘要。

这台机器 Node 的 fetch 无法通过 TLS 校验的根因：**Watt Toolkit（Steam++）的 GitHub 加速**把 27 个 github 域名写进 hosts 指向 127.0.0.1，用自签 CA（`CN=SteamTools Certificate, O=BeyondDimension`）做本地 TLS 中转；Node 默认不读 Windows 系统证书库，故报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。

1. **tokscale 二进制**：`node_modules/@tokscale/cli-win32-x64-msvc/bin/tokscale.exe` 已替换为 vendored fork 构建（sha256 `c30cf198…`，与 `scripts/vendor/tokscale.json` 一致），`ensure:tokscale` 现走"已匹配免下载"分支。
2. **Electron 43.4.0**：npm postinstall 下载失败，已手动从 npmmirror 下载官方 zip（sha256 `ef0709cf…`，与包内 `checksums.json` 一致）解压至 `node_modules/electron/dist/` 并写入 `path.txt`（注意必须无 CRLF）。
3. **`NODE_USE_SYSTEM_CA=1`**（用户级环境变量，已持久化）：让 Node 信任 Windows 系统证书库。该变量不依赖 Steam++：加速开启时必需，关闭时无副作用，其他代理工具的 MITM 证书（若装在系统库）同样被覆盖。
4. 已知边界：`github.com`（Release 下载、git 推拉）在加速关闭且无 TUN 代理时受网络干扰直连不通（api.github.com 直连正常）；`ensure:tokscale` 使用原生 fetch、不读 `HTTPS_PROXY`。

## 五、验证结论

- `npm test`：**5250 通过 / 0 失败**（含新增 10 个用例）。← 2026-09-29 首版基线；当前状态见第九节。
- `npm run lint`：无告警。
- `npm run sync:worker` + `npm run update:hub-build`：已执行，Hub 构建身份 registry 已更新（核心闭包哈希变化 → core rev 追加）。
- 真实 DSH 数据端到端验证（本机 `~/.dsh`，90 会话 / 103 路由条目）：
  - 合并视图旧行 `deepseek-v4.1-flash` = 600,935,326 tokens；
  - mixed 视图拆分：`router / …` 517,407,888 ＋ `router9 / …` 61,710,043 ＋ `kala / …` 20,369,095 ＋ `uuapi / …` 1,448,300，**总和与合并值精确相等**。

## 六、回放与撤销

```bash
# 在上游 v0.76.0（ce26462f）的工作区应用全部修改：
git apply docs/CHANGES-LOCAL.patch
# 撤销：
git apply -R docs/CHANGES-LOCAL.patch
# 补丁未包含本记录文档自身；验证环境另见第四节。
```

## 七、Windows 打包（exe 安装包 + 绿色版）

产物（`npm run dist:win` 的两个 target，文件名带版本号）：

- **安装包**：`dist/Token-Monitor-Setup-<version>.exe`（NSIS，per-user 安装，无需管理员）
- **绿色版**：`dist/Token-Monitor-<version>.exe`（portable，单文件免安装）

本机打包走 `scripts/build-win-local.bat`（2026-10-21 起入库），它是绕开 GitHub 直连不稳定的一层封装，见第十一节。底层的手工步骤留档备查：

1. **预置 electron-builder 工具缓存**（npmmirror 镜像 + curl 下载，落到 `%LOCALAPPDATA%\electron-builder\Cache\<releaseName>\<file>`，electron-builder 检测到 archive 缓存即跳过联网；sha256 已与 `app-builder-lib/out/toolsets/*.js` 内的常量核对）：
   - `7zip@1.0.0/7zip-win-x64.tar.gz`
   - `winCodeSign-2.6.0/winCodeSign-2.6.0.7z`
   - `nsis-3.0.4.1/nsis-3.0.4.1.7z`
   - `nsis-resources-3.4.1/nsis-resources-3.4.1.7z`
2. **复用本地 electron**（避免再次下载 144MB zip）：构建命令加 `--config.electronDist=node_modules/electron/dist --config.electronVersion=<本地已装版本>`
3. 完整命令（脚本内部就是这些环境变量 + 这条命令）：
   ```bash
   NODE_USE_SYSTEM_CA=1 \
   ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
   ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
   npx electron-builder --win --x64 --publish never \
     --config.electronDist=node_modules/electron/dist --config.electronVersion=<本地已装版本>
   ```
4. 本地产物未签名（正式签名在 CI 的 SignPath 步骤）：安装/首次运行时 SmartScreen 会提示，选"更多信息 → 仍要运行"。
5. 打包产物已验证：`app.asar` 内含新功能代码（`modelProviders`×22、`modelBreakdownRows`×5），win-unpacked 版启动冒烟通过（collector 正常监控 11 个客户端目录）。

## 八、完整文件清单（git status）

修改（M）：`AGENTS.md`、`src/electron/main.js`、`src/electron/modelAliasPresentation.js`、`src/electron/renderer/app.js`、`src/electron/renderer/i18n.js`、`src/electron/renderer/index.html`、`src/electron/renderer/styles.css`、`src/shared/hubBuildRegistry.json`、`src/shared/usage.js`、`tests/electron/macWidgetLaunchServicesRecovery.test.js`、`tests/electron/modelAliasPresentation.test.js`、`tests/helpers/sourceEnv.js`、`tests/shared/clientStatus.test.js`、`tests/shared/customScanPaths.test.js`、`tests/shared/usage.test.js`、`worker/src/shared/hubBuildRegistry.json`、`worker/src/shared/usage.js`

新增：`docs/PROJECT_MAP.zh-CN.md`、`docs/CHANGES-LOCAL.zh-CN.md`、`docs/CHANGES-LOCAL.patch`、`docs/USAGE-INTERFACES.zh-CN.md`、`docs/NETWORK-SETUP.zh-CN.md`、`src/electron/renderer/modelBreakdownRows.js`、`tests/electron/modelBreakdownRows.test.js`

## 九、2026-10-09：rebase 到上游 v0.68.0 + 刷新延迟排查

### 9.1 上游同步

`git fetch origin && git rebase origin/main`：4 个本地提交（原 `47fdbd50`…`a4a0168f`）无冲突重放到 `891ac799`（v0.68.0，Electron 43.7.9）之上；唯一冲突是 `hubBuildRegistry.json` 的 core revision 75 —— 上游 release 提交已占用该编号，本地那条基于旧闭包哈希已作废，**保留上游的 75**，本地改动由 `npm run update:hub-build` 追加为 revision 76。重放前的原状态留有 `backup/local-work` 分支与 `pre-rebase-local` 标签。

### 9.2 「token 统计要手动刷新」的排查结论（未复现）

反馈是：改版后 token 统计延迟高、要手动刷新。用本机真实数据（`%APPDATA%\Token Monitor\collector-anchor.json`、真实 tokscale 扫描、真实客户端目录）做了 A/B，**没有复现出这次改动引入的刷新回归**：

| 测量项 | 上游 891ac799 | 本地 | 结论 |
|---|---|---|---|
| 真实 warm tick（锚定 `--today`，含 normalize + aggregate） | 931 ms | 927 ms | 无差异 |
| 真实 anchor 上的 `normalizePeriod` / `applyPeriodDelta` / `normalizeDeviceRecord` / `aggregateDevices` | 基准 | 全部持平（±3%，噪声内） | 无差异 |
| `extractUsageFromTokscale`（9000 行，dsh 式 1/3 带路由 / 全无路由） | 基准 | −1.7% / −2.7% | 无差异 |
| 两次 warm tick 的 `--cpu-prof` self-time 前 22 项 | 基准 | 逐项吻合，`modelProviders` 代码未进榜 | 无差异 |
| 打包版 `dist/win-unpacked` vs 源码版 | — | 均 0 long task、0 breakdown 重建 | 无回归 |
| 实跑 widget（源码版 + 打包版，CDP 探针） | — | watch tick 间隔中位数 3.6 s，record→push 6–10 ms | 符合 3–5 s 承诺 |

唯一确认的成本是**载荷变大**：allTime JSON 增加约 0.8%（`modelProviders` 随 record 一起下发，没有任何地方像 `sessions` 那样被剥离）。本机 today 只有 2 个路由条目，量级可忽略。

排查中排除的假设：`worker/src/shared/` 与 `src/shared/` 漂移（`npm run sync:worker` 干净）；`app.asar` 缺文件（`worker/` 是 Cloudflare Worker，本就不该进桌面包）；renderer 静默抛错（preload 的 `try/catch` 会吞异常，但 CDP 探针显示 0 long task、`render()` 正常跑完）。

### 9.3 顺带修掉的两个缺陷

| 文件 | 问题 | 修复 |
|---|---|---|
| `src/electron/modelAliasPresentation.js` | `foldModelProviderMap` 把**源 period 的子对象直接放进结果**再就地累加，等于改写了已发布的快照（`docs/architecture.md` 的不可变约定）。同一个快照被二次投影（presentation 重算）时数字会翻倍 | 合并进新建的容器、条目一律 `{ ...metrics }` 拷贝；补 `tests/electron/modelAliasPresentation.test.js` 回归用例 |
| `src/shared/usage.js` | `normalizeProviderName` 对**每一条**扫描行都跑一遍正则，多数行根本没有 `provider` | 缺失值提前返回（语义不变：`0` / `false` 仍视为无路由）；补 `tests/shared/usage.test.js` 用例锁定字符串 / 空串 / 空白 / null / 缺字段五种写法 |

第二条**实测无可测量收益**（V8 对空串 `replace` 已优化得很好），保留它是因为它位于全局最热的循环上且是明显的意图声明，不要当成性能修复看待。

### 9.4 顺带修掉的本机测试污染（同第二节那一类）

排查过程中顺带定位并修掉了第二节那批 Windows 测试污染的**遗漏项**：本机导出了 `DSH_HOME=C:\Users\ACER\.dsh`，而 `resolveDshHome()` 先看 `DSH_HOME` 再回落 `~/.dsh`，所以所有把 `homeDir` 指向临时夹具的 DSH 测试，实际都去读了**真实的** `~/.dsh` 会话树 —— 夹具会话表现为「有记录、无 transcript」，是静默 miss 而不是报错。表现是 10 个断言失败（`collectorSessionTimestamps`×7、`collectorTriStatePropagation`×2、`dshSessionFiles`×1），在上游 `origin/main` 上逐一复现。

修法沿用第二节已有机制，没有新造：`DSH_HOME` 加进 `tests/helpers/sourceEnv.js` 的 `SOURCE_ENV_KEYS`，并在这三个测试文件里 `installSourceEnvGuard(test)`（该文件顶部注释本身就要求「按文件安装，而不是逐用例记住」）。修正后 **49 通过 / 0 失败**。

### 9.5 当前验证状态

- `npm run lint`：无告警。
- `npm test`：**6214 通过 / 1 失败**（该唯一失败见下）。
- `npm run sync:worker` + `npm run update:hub-build`：已执行，core revision 76。

> 唯一剩余失败：`tests/agent/titleSync.test.js` 的 "real process exit after remote admission…" —— 测试让子进程在 `fetch` 回调里 `process.exit(0)`，Windows 上该子进程以 `3221226505`（`0xC0000409`）退出。在 `origin/main` 上同样稳定复现，属上游 Windows 问题，与本地改动无关。要修就得改这个测试「如何退出」，那会改变它验证的东西，故留待单独处理。

## 十、2026-10-21：rebase 到上游 v0.76.0

### 10.1 上游同步

`git fetch upstream` 后 `upstream/main` = `ce26462f`（v0.76.0 发布后 9 个提交），比上次同步点 `891ac799` 前进 **97 个提交**。8 个本地提交 `git rebase upstream/main` 全部重放，**2 处冲突**，都在 `src/shared/hubBuildRegistry.json` 与 `worker/src/shared/hubBuildRegistry.json` 的 core 列表尾端。

冲突处理沿用 9.1 的约定：**保留上游的 core 列表**（1..90），本地闭包交给 `npm run update:hub-build` 追加，而不是手改生成的 Worker 元数据。本次追加为 **core revision 91**（`sha256:0798135f…`）。重放前的原状态留有分支 `backup/pre-rebase-20261021` 与标签 `pre-rebase-local-20261021`。

其余文件全部自动合并 —— 上游 97 个提交与本地改动的 hunk 基本不相交，`src/electron/renderer/app.js`（上游 +2015 行）与 `src/shared/usage.js`（上游 +149 行）都一次过。

### 10.2 功能保留验证

上游这 97 个提交**完全不涉及**本地功能用到的符号 —— `git grep 'modelProviders\|model_providers\|modelBreakdownMode\|foldModelProviderMap' upstream/main` 零命中。所以本地功能与上游的 `feat(projects): add tool and model breakdown toggle (#1086)` 不冲突：后者是**项目视图**里「工具 / 模型」的分组维度，本地这项是**供应商路由**维度的拆分，两者正交。

rebase 后 `git diff upstream/main main` = **27 文件 / +4854 / −21**，与 rebase 前的形态一致（仅多出 hub build registry 的 revision 91）。三模式接线逐项复核通过：

| 位置 | 状态 |
|---|---|
| `src/electron/renderer/index.html` | `modelBreakdownModeHost` 按钮组 + `<script src="modelBreakdownRows.js">` |
| `src/electron/renderer/i18n.js` | `views.modelBreakdownMode` / `views.modelBreakdown.{mixed,model,provider}` × 6 语言（en / zh-TW / zh-CN / ko / ja / pt-BR） |
| `src/electron/main.js` | `defaultSettings.modelBreakdownMode = 'mixed'` + `normalizeModelBreakdownMode` + `settings:update` 白名单 |
| `src/electron/renderer/app.js` | `modelRowsForPeriod` 三模式分发、`syncModelBreakdownModeControls`、render() 显隐、点击绑定 |
| `src/shared/usage.js` | `modelProviders` 的 emptyPeriod / addUsageRowToPeriod / normalizePeriod / addPeriodInto / cursor-auto 重键迁移 |
| `src/electron/modelAliasPresentation.js` | `foldModelProviderMap`（不写入源 period 的拷贝式合并） |

### 10.3 验证状态

- `npm run lint`：无告警。
- `npm test`：**7565 通过 / 2 失败**（终态；rebase 后的首轮全量是 7564 / 3，多出的那个是下表的偶发项）。
- `npm run sync:worker` + `npm run update:hub-build`：已执行，core revision 91。
- `docs/CHANGES-LOCAL.patch`：按新基线 `ce26462f` 重建。

**纯上游基线对照**：在同一台机器上把 `upstream/main` 完整跑一遍是 **7541 通过 / 14 失败**。上游多出来的那 12 个失败全部是 DSH 会话时间戳与 VS Code / Antigravity 存在性探测类用例 —— 正是第二节与 9.4 那批 source env 隔离修掉的；本地分支把它们全部修好，自己只剩下面这 2 个。这条对照也说明本地分支相对上游是净收益，不是净负担。

| 失败用例 | 结论 |
|---|---|
| `tests/agent/titleSync.test.js` "real process exit after remote admission…" | 上游 Windows 问题，退出码 `3221226505`（`0xC0000409`），9.5 已记录，未变；纯上游基线同样失败 |
| `tests/shared/verifyVendoredTokscaleRelease.test.js` "real vendor manifest derives complete target coverage from @tokscale/cli" | 本机 `node_modules` 的 `@tokscale/cli` 仍是 4.18.0，上游 manifest 已提到 4.20.0 —— 环境落后于上游，非代码问题；纯上游基线同样失败 |
| `tests/shared/usageHost.test.js` "a subprocess on the worker does not outlive a process that exits right after stopping it" | 偶发项（退出码 `3221225477` = `0xC0000005` 访问违例）：全量并行跑时出现过 2 次、也通过过 2 次；单独跑该文件时本地与上游**都通过**。属 Windows 子进程退出竞态，与本地改动无关 |

> 前两个失败都不需要动代码：前者要改测试「如何退出」才能过，那会改变它验证的东西；后者只需把 `node_modules` 刷到 `@tokscale/cli` 4.20.0。两者都留待单独处理。

## 十一、2026-10-21：Windows 打包脚本入库，并补两道产物校验

### 11.1 为什么之前没入库

`scripts/build-win-local.bat` 之前是未跟踪文件。脚本本身写得没问题，但留在工作树里有两个后果：一是仓库一换就丢；二是它引用了本记录第七节，而第七节描述的却是 0.63.1 时期的手工步骤 —— 文档与脚本各说各话。

### 11.2 补的两道校验

原脚本只负责"把 electron-builder 跑通"，产物对不对全靠人看 `dir dist\*.exe` 的日期列。补上两道自动校验：

| 位置 | 校验 | 为什么 |
|---|---|---|
| 构建前 | `node scripts/update-hub-build.js --check` | `src/hub` 与 `src/shared` 都进包，hub build marker 陈旧就会把过期的 Hub build identity 发给 widget。AGENTS.md 要求"最后一次 Hub/shared 改动后跑一次 `npm run update:hub-build`"，但**检查**比刷新更安全 —— 脚本绝不写工作树，陈旧就中止，让人去跑更新并提交 |
| 构建后 | 断言 `dist\Token-Monitor-Setup-<version>.exe` 与 `dist\Token-Monitor-<version>.exe` 存在，再跑 `npm run verify:release-artifact-names` | `dist\` 里的旧版本产物不会被清理，"构建结束"不等于"该发的文件在"。第一条挡住拿错版本，第二条用仓库自带的校验器确认 `latest.yml` 引用的产物确实在盘上 |

为此给 `scripts/update-hub-build.js` 加了 `--check`：默认行为（无参数）完全不变，仍然追加 revision 并退出 0；带 `--check` 时只在陈旧时退出 1 且**不写文件**。

### 11.3 实测

- `--check` 两条分支都验过：陈旧 → 退出 1 并打印指引；最新 → 退出 0。制造漂移的方式是给 `src/shared/projectKey.js` 临时加一行，验完用 `git checkout --` 精确还原。
- 脚本整体实跑：前置检查、版本探测（app 0.76.0 / electron 43.7.9）、新的 marker 闸门、以及各失败路径的输出都正确。把 marker 弄陈旧后重跑，在**构建开始前**就中止并给出可执行指引，工作树未被改动。
- **完整构建跑通**（2026-10-21，v0.76.0）：`dist\Token-Monitor-Setup-0.76.0.exe`（125,834,253 字节）与 `dist\Token-Monitor-0.76.0.exe`（125,533,304 字节），末尾的产物校验（两个文件名断言 + `verify:release-artifact-names`）均通过。解包 `app.asar` 复核功能确实在包里：`usage.js` 19 处 `modelProviders`、`renderer/app.js` 16 处 `modelBreakdownMode`、`i18n.js` 18 个 `views.modelBreakdown.*` 键（6 语言 × 3 键）、`modelBreakdownRows.js` 在包内、`hubBuildRegistry.json` 为 core revision 91。

### 11.4 跑通前的两个坎（都是环境问题，不是脚本问题）

| 坎 | 症状 | 解法 |
|---|---|---|
| `node_modules` 落后于上游 | `ensure:tokscale` 拒绝替换：`Installed @tokscale/cli-win32-x64-msvc is 4.18.0, but this vendor override was built against 4.20.0`。`package.json` 声明的是 `tokscale = ^4.20.0`，是本地 `node_modules` 没跟上 | `npm install`（npm 源是 npmmirror，本机 1 秒完成）。这也顺带修好了第十节记的 `verifyVendoredTokscaleRelease` 失败 |
| GitHub release 下载超时 | fork 版 tokscale 是 GitHub release 里的 29MB 资产，`ensure-vendored-tokscale.js` 给下载设了 **60 秒硬超时**，直连本机 **4 分钟都下不完**（最终 `This operation was aborted`） | 让 Node 走代理：Node 24 支持 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`，**同一个文件 8.6 秒下完**。脚本现在检测到 `HTTPS_PROXY`/`HTTP_PROXY` 就会自动设 `NODE_USE_ENV_PROXY=1` |

> 代理这一条也解释了为什么 `ensure-vendored-tokscale.js` 明明能连通 GitHub（HEAD 请求 200）却下不动文件：连通 ≠ 带宽够，而超时是按整段下载算的。
