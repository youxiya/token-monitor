# 本机网络环境与修复手册

> **目的**：记录这台机器（Windows 11，中文网络环境）的网络工具栈、为修通开发工具链所做的全部持久化修改、每种网络故障的根因与处理方法。供日后排障、重装系统后恢复、或迁移到新机器时照抄。
> **整理日期**：2026-09-29。所有结论均经实测验证，诊断命令见 §5。

---

## 1. 本机网络工具栈全景

| 工具 | 机制 | 对流量的影响 |
|---|---|---|
| **Watt Toolkit（Steam++）** GitHub 加速 | 把 27 个 github 域名写进 hosts 指向 `127.0.0.1`，本机起反向代理转发到真实 GitHub，转发时用**自签 CA**（`CN=SteamTools Certificate, O=BeyondDimension`，装在 Windows 信任库 LocalMachine\Root 与 CurrentUser\Root，2027-02 到期）完成 TLS | 只接管 hosts 里的域名；界面开关切换时会清理/恢复 hosts——**强杀进程会留残留** |
| **mihomo-smart（Clash Meta 内核）** | 两种模式：**系统代理**（写注册表 `HKCU\...\Internet Settings`：`ProxyEnable=1, ProxyServer=127.0.0.1:7890`）与 **TUN 模式**（IP 层接管，不写注册表） | 7890 是**纯 HTTP 代理**端口（不说 TLS）；TUN 模式下流量在 IP 层透明转发，应用看到的是直连 |
| **直连** | 无代理 | 实测：`api.github.com` ✅（200，1–2s）；`github.com` ❌（TCP 能连、TLS 握手被丢包、15s 超时）→ 网页/Release 下载/git 推拉直连不可用 |

**关键认识：三个开关互相独立**。Steam++ 加速、mihomo 系统代理、mihomo TUN 各自独立存在；排障时先搞清当前是哪个在接管（§5 自检命令）。

---

## 2. 持久化的修改（已生效，重装系统后需重新执行）

### 2.1 用户级环境变量（`setx` 写入 HKCU\Environment）

| 变量 | 值 | 解决什么 | 依赖性 |
|---|---|---|---|
| `NODE_USE_SYSTEM_CA` | `1` | Node 默认信任自带 Mozilla CA 清单，不认 Steam++ 装进系统库的 MITM 证书 → 一切 Node 访问 github 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。设了之后 Node 改用 Windows 系统证书库（与浏览器同一信任源） | **不依赖 Steam++**：加速关闭时无副作用；其他做 MITM 的代理工具（CA 装在系统库的）同样受益。影响 node / npm 脚本 / Electron 43 内置 Node（≥22.15）内的 electron-updater |
| `NO_PROXY` | `pypi.tuna.tsinghua.edu.cn,.tsinghua.edu.cn,localhost,127.0.0.1,mirrors.aliyun.com,mirrors.cloud.tencent.com` | CPython 读注册表系统代理的怪癖（见 §3.2）导致 pip 必挂；国内镜像域直接绕过代理 | **不依赖任何代理工具**；只让列出的域直连，不影响 mihomo 对其他流量的代理；浏览器不读此变量 |

撤销方法：`setx NODE_USE_SYSTEM_CA ""` 后删残留（或 `reg delete HKCU\Environment /v NODE_USE_SYSTEM_CA /f`）；NO_PROXY 同理。

### 2.2 手动安装的二进制（npm 下载被网络阻断的替代）

| 项 | 位置 | 校验 |
|---|---|---|
| tokscale vendored 二进制 | `node_modules\@tokscale\cli-win32-x64-msvc\bin\tokscale.exe` | sha256 `c30cf198…`（与 `scripts/vendor/tokscale.json` 一致）；装好后 `ensure:tokscale` 走"已匹配免下载"分支 |
| Electron 43.4.0 | `node_modules\electron\dist\` + `path.txt`（内容 `electron.exe`，**必须无 CRLF**） | zip sha256 `ef0709cf…`（与包内 `checksums.json` 一致）；来源 npmmirror |
| electron-builder 工具缓存 | `%LOCALAPPDATA%\electron-builder\Cache\<releaseName>\<file>`（4 个包，见 CHANGES-LOCAL §7） | sha256 均与 `app-builder-lib/out/toolsets/*.js` 内常量核对 |

**通用下载姿势**（本机 curl 走 npmmirror 稳定，Node fetch 走 github 不稳）：

```bash
curl -sL --max-time 300 "https://npmmirror.com/mirrors/<路径>" -o <输出文件>
```

### 2.3 构建用的镜像环境变量（按需临时设置，未持久化）

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

electron-builder 的工具集 URL 形如 `<mirror>/<releaseName>/<file>`（releaseName 如 `winCodeSign-2.6.0`、`7zip@1.0.0`）；预置到缓存后构建零联网。完整打包命令见 `CHANGES-LOCAL.zh-CN.md` §7。

---

## 3. 已知故障模式与根因（按报错对号入座）

### 3.1 Node 工具链报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`

- **症状**：node / npm 脚本 / ensure-vendored-tokscale / electron 下载，访问 github 报 `unable to verify the first certificate`。
- **根因**：Steam++ 加速开启时，Node 看到的证书是自签的 `SteamTools Certificate`，不在 Node 自带 CA 清单里。
- **处理**：确认 `NODE_USE_SYSTEM_CA=1` 已设置且**该终端是新开的**（setx 只影响新进程）；浏览器/掘伴随工具有影响吗——没有，它们本来就读系统库。

### 3.2 pip 报 `ProxyError('Cannot connect to proxy.', FileNotFoundError(2, 'No such file or directory'))`

- **症状**：pip 装任何包都失败，与 Steam++/TUN/代理开关**无关**（实测 Anaconda pip 与 AstrBot 实例 pip 同样失败）。
- **根因链**（traceback 定位到 `_connect_tls_proxy → ssl do_handshake`）：
  1. mihomo 系统代理常开 → 注册表 `ProxyEnable=1, ProxyServer=127.0.0.1:7890`；
  2. CPython `getproxies_registry()` 对简单格式给每种协议前缀各自方案名 → https 的代理被解析为 **`https://127.0.0.1:7890`**（要求代理本身说 TLS）；
  3. pip vendored urllib3 1.26 忠实地对代理做 TLS 握手 → 7890 是纯 HTTP 代理 → 握手失败在 Windows 上映射为 `FileNotFoundError(2)`。
- **处理**：国内镜像已被 `NO_PROXY` 覆盖（自动直连）；要 pip 走代理装国外包时，用 **TUN 模式**（注册表不参与，pip 视为直连），或当前会话显式 `$env:HTTPS_PROXY='http://127.0.0.1:7890'`——**必须 `http://`**。
- **旁证**：`curl -x http://127.0.0.1:7890` 一切正常——坏的只是"把 HTTP 代理当 HTTPS 代理"这一种组合。

### 3.3 GitHub 完全连不上（连浏览器都不行）

- **根因**：hosts 残留 `127.0.0.1` 条目但 Steam++ 的本地代理进程不在（强杀进程/异常退出）。
- **处理**：重新打开 Watt Toolkit，用**界面开关**切一次加速（它会重写 hosts）；或彻底关闭加速让 hosts 恢复。自检：`nslookup api.github.com` 返回 `127.0.0.1` 即有本地接管。

### 3.4 electron-builder 构建卡 600s 超时

- **根因**：工具集（winCodeSign/NSIS/7za）缓存为空时需要联网下载，直连 github 不稳。
- **处理**：按 §2.2 预置缓存 + 用 `--config.electronDist=node_modules/electron/dist` 复用本地 electron（完整步骤见 CHANGES-LOCAL §7）。

### 3.5 Electron 启动报 "Electron failed to install correctly"

- **根因**：npm install 的 postinstall 下载 electron zip 失败；或手动安装时 `path.txt` 被 Git Bash `echo` 写成 CRLF（13 字节）导致 electron 包判定二进制缺失。
- **处理**：按 §2.2 手动安装；`path.txt` 用 node 写：`node -e "require('fs').writeFileSync('node_modules/electron/path.txt','electron.exe')"`。

### 3.6 `github.com` 直连超时（api.github.com 却正常）

- **根因**：网络层对 `github.com` 域的 TLS 干扰（连接能建立、ClientHello 后被丢包）。**这不是本机配置问题，任何环境变量都救不了连接层。**
- **处理**：需要访问 `github.com` 的操作（git 推拉、Release 下载、应用内更新）走 Steam++ 加速或 TUN 模式。

---

## 4. 可用性状态矩阵

| 操作 | Steam++ 加速开 | mihomo TUN 开 | 纯直连（全关） |
|---|---|---|---|
| pip 装国内镜像包 | ✅（NO_PROXY 绕过） | ✅ | ✅ |
| node/npm 访问 github（下载、API） | ✅（需 NODE_USE_SYSTEM_CA） | ✅ | ❌（github.com 被干扰） |
| 访问 api.github.com（REST API） | ✅ | ✅ | ✅（实测 200） |
| git 推拉 GitHub / Release 下载 | ✅ | ✅ | ❌ |
| 浏览器上 GitHub | ✅ | ✅ | ❌ |
| Electron 应用内自动更新 | ✅（NODE_USE_SYSTEM_CA 对 Electron 内置 Node 同样生效） | ✅ | ❌ |

**结论**：日常保持现状（Steam++ 加速开 + 两个环境变量）是摩擦最小的组合；`github.com` 类操作在"全关"状态下无解，属网络层限制。

---

## 5. 诊断命令速查

```powershell
# 1. 当前谁在接管 github（127.0.0.1=本地接管；公网 IP=直连）
nslookup api.github.com

# 2. 系统代理注册表状态（pip 问题的第一现场）
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' |
  Select-Object ProxyEnable, ProxyServer, AutoConfigURL

# 3. 7890 端口是谁在听（mihomo / Steam++ / 其他）
Get-NetTCPConnection -LocalPort 7890 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess } | Select-Object ProcessName, Id

# 4. Node 证书链验证（应输出 HTTP 200）
node -e "fetch('https://api.github.com/repos/Javis603/token-monitor').then(r=>console.log('HTTP',r.status))"

# 5. Python 实际解析到的代理（注意 https 的 scheme 是否被写成 https://）
python -c "import urllib.request; print(urllib.request.getproxies())"

# 6. pip 绕过一切代理直连
$env:NO_PROXY='*'; pip install <pkg> -i https://pypi.tuna.tsinghua.edu.cn/simple

# 7. hosts 里 github 相关条目计数（Steam++ 是否在接管）
(Select-String -Path C:\Windows\System32\drivers\etc\hosts -Pattern github).Count
```

深挖 TLS 问题时的异常链钻取（找到 `FileNotFoundError` 的真实抛出点）：

```python
import traceback, requests
try:
    requests.get('https://pypi.tuna.tsinghua.edu.cn/simple/pip/', timeout=15)
except Exception as e:
    cur, depth = e, 0
    while cur is not None and depth < 8:
        print('===', depth, type(cur).__name__, repr(cur)[:200])
        if type(cur).__name__ == 'FileNotFoundError':
            traceback.print_exception(type(cur), cur, cur.__traceback__); break
        cur = cur.__cause__ or cur.__context__; depth += 1
```

---

## 6. 相关文档

- `docs/CHANGES-LOCAL.zh-CN.md` §4（环境修复清单）/ §7（Windows 打包完整命令）——本手册的代码侧配套记录
- `docs/PROJECT_MAP.zh-CN.md`——项目本身的功能地图
- 上游相关配置：`.env.example`（应用自身的代理变量 `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY`，应用内 limits 请求经 `outboundFetch.js` 读取）
