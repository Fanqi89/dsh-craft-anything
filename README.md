# dsh-craft-anything

把 [Craft Anything](https://github.com/storytold/craft-anything)（ArtCraft 的开源「看清任意软件怎么工作，再让 AI 帮你重做一个」引擎）接进 **DeepSeek Harness (DSH)**：
本地 `craft-anything-cli` 的 MCP 工具以 `mcp__craft__*` 出现在 DSH 里，另配状态页、命令运行器、安装器和**净室 / 深度模式切换**。

> Craft Anything 是一个纯 Rust、MIT/Apache-2.0 双许可的逆向研究引擎：301 个引擎工具 / 17 个工具集，
> 能研究网站、桌面应用、手机应用、游戏、固件与文件格式，带证据记录，并可交给编码智能体重建。
> 本仓库只做「DSH 接入层」，不包含也不修改上游代码。与 ArtCraft / Storytold 无隶属关系。

---

## 功能

| 能力 | 说明 |
|---|---|
| **MCP 桥** | 用 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 连接本地 `craft-anything-cli mcp`，工具名 `mcp__craft__core_target_open` 等。默认暴露 Essentials（30 个工具）；深度模式 38 个；运行时用 `mcp__craft__list_toolsets` / `mcp__craft__enable_toolset` 按需加载 native / browser / android / java / managed / formats 等工具集。 |
| **模式切换（净室 ⇄ 深度）** | DSH 对话框左下角工具行里的下拉开关（「净室模式 / 深度模式」，紧邻其它插件的模式开关但不重叠）；也可用 `craft_mode` 工具切换。切换会写入 `mode.json` 并重启 MCP 服务进程，`dsh-mcp-client` 自动重连，工具列表 1–2 秒内在新模式重新同步。重启使用「SIGTERM → 1.5 秒 SIGKILL → 3 秒强制退出」的兜底，进程不响应信号也不会把 DSH 拖住。 |
| **状态工具** `craft_status` | CLI 路径/版本、是否 portable、工具集与工具数量、可用引擎（chromium/gdb/java/objdump…）、Ghidra 与编码智能体是否就绪、MCP 连接方式。结果缓存 5–10 分钟，`refresh:true` 强制重跑。 |
| **命令运行器** `craft_cli` | 以参数数组直调 CLI（无 shell）：`rebuild`、`doctor`、`setup`、`report`、`triage`、`commands`、`capabilities` 等。长任务可放大 `timeoutMs`；取消/超时会 SIGKILL 兜底，不会挂住工具调用。 |
| **安装器** `craft_install` | 从 GitHub Releases 下载官方 CLI 到 `~/.dsh/plugins-data/craft-anything/<版本>/`，**解压前校验 SHA256**（对照 release 的 `SHA256SUMS.txt`），已安装则秒回；成功后自动重启 MCP 桥以使用新 CLI（无需重开 DSH）。Windows 用 portable zip（`scripts/install-cli.ps1`），macOS 用官方 universal CLI zip，Linux 用 release tarball（best effort）。 |
| **MCP 桥按需开关 / 工具白名单** | 响应 issue #1：桥默认仍全开，但可在页面或输入栏一键关闭（`mcp__craft__*` 工具立即从上下文移除），或用 `allow` 白名单（如 `core_*`）只注册需要的工具；通过 MCP `tools/list_changed` 动态重同步，**不重启 CLI/桥/DSH**。另有 `craft_bridge` 工具。 |
| **中英文切换** | 页面右上角「中文 / English」分段开关，切换整个页面、模式菜单与所有卡片文案；选择记在 localStorage，首次打开跟随浏览器语言（中文系统自动中文）。 |
| **环境与依赖（一键补齐）** | 新增「环境与依赖」卡：按操作系统自动检查 CLI、Chromium 浏览器、Claude Code 编码智能体、Ghidra、Java 21+、GDB；可自动安装的项右侧直接「一键安装」（后台任务 + 实时日志），手动项「复制命令」；顶部「一键补齐可自动项」一次处理全部缺失项。 |
| **状态页** | 左侧栏「Craft Anything」图标 → 中央面板显示本地安装、能力、MCP 桥与常用命令；数据来自插件自己的 `GET /craft-anything/api/status`（默认缓存 60 秒，页面手动刷新走 `?full=1`）。 |

截图（DSH 对话框左下角的模式开关、左侧栏入口、状态页）见仓库 Releases / 使用说明；界面文字与状态实时读取本机。

---

## 安装

### 前置

- DeepSeek Harness 桌面版 **0.2.1-rc.2 或更新**（`package.json` 的 `engines.dsh` 与 `dsh.plugin.json` 都声明 `>=0.2.1-rc.2`；依赖它自带的 `@deepseek-ai/dsh-mcp-client`）。
  - Host 侧（MCP 桥、四个工具、HTTP 路由）自 0.2.1-rc.2 起可用；
  - 界面侧（左侧栏入口、状态页、对话框左下角模式开关）在 0.2.1-rc.5 上真机验证过；更老的 Harness 若没有对应槽位，这几块**自动不出现**，其余功能不受影响；
  - 0.2.2-rc1 及以后：插件只用稳定 API（`ctx.tools.register`、`ctx.effect`、`ctx.inject(['webServer'])`、`slots.inject/register`、`window.__ModuleLoader__`），没有依赖已废弃的私有接口；API 若有变化会在 [CHANGELOG](CHANGELOG.md) 里注明并跟随发版。
- **不需要单独安装 Node**：MCP 启动器以 `command: !!js process.execPath` + `ELECTRON_RUN_AS_NODE=1` 运行在 DSH 自带的 Node 上（Windows/macOS/Linux 一致）。若某个 DSH 构建关闭了 Electron 的 RunAsNode fuse，把该行的 `command` 改成 `node` 并确保 PATH 里有 Node（见「排障」）。
- 想用 `rebuild` 的话另需一个编码智能体（如 Claude Code）或 API Key；只做「研究/分析」不需要。
- `craft_install` 支持 Windows（portable zip）、macOS（官方 universal CLI zip）、Linux（release tarball，best effort）；都带 SHA256 校验。

### 版本与安装指定版本

仓库按语义化版本打**不可移动的标签**（`v0.1.0`、`v0.2.0`…），每个版本一个 GitHub Release；新版本只增加标签、不覆盖旧标签，因此老版本随时可装：

```powershell
dsh plugin --profile desktop add github:Fanqi89/dsh-craft-anything#v0.1.1   # 固定版本
dsh plugin --profile desktop add github:Fanqi89/dsh-craft-anything          # 跟 main 最新
```

发布流程与规则见 [RELEASING.md](RELEASING.md)。

### 从 GitHub 安装（推荐）

```powershell
dsh plugin --profile desktop add github:Fanqi89/dsh-craft-anything
```

装好后在 DSH「插件」页启用 **Craft Anything**，然后让模型或自己执行一次安装 CLI：

```text
craft_install            # 下载/更新官方 CLI（Windows，带 SHA256 校验）
craft_status             # 确认版本、引擎与模式
```

或者手动先装 CLI（跳过 `craft_install`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <插件目录>\scripts\install-cli.ps1
```

### 本地目录安装（开发/自用）

```powershell
plugin_manager install_bundle   # target: <本仓库绝对路径>
# 或者：dsh plugin --profile desktop add link:<本仓库绝对路径>
```

两种方式都由 DSH 的插件管理器完成，不要手改 profile 的 `package.json` / `cordis.patch.yml`。

---

## 使用

### 1) 研究一个目标（净室模式，默认）

```text
mcp__craft__core_target_open   { "path": "C:\\Windows\\System32\\where.exe" }
mcp__craft__core_target_triage
mcp__craft__core_evidence_show { "detail": "summary" }
mcp__craft__core_report_write  { "format": "markdown" }
```

净室模式下只允许「从外面看」的工具；会读到目标内部（代码/文件/页面源码）的工具会被拒绝并说明如何打开深度模式。

### 2) 切换净室 / 深度

- 对话框左下角工具行的下拉开关：`● 净室模式 ▴` → 选「深度模式」；
- 或 `craft_mode { "mode": "deep" }`（不带参数只读取当前模式）；
- 或单次命令加 `--deep`：`craft_cli { "args": ["rebuild", "<目标>", "<想要什么>", "--deep"] }`。

切换是**全局**的（对整个 DSH 的 MCP 连接生效），并会重启 MCP 服务，因此进行中的 MCP 调用会失败，工具列表 1–2 秒后刷新。

### 3) 让编码智能体重建

```text
craft_cli { "args": ["rebuild", "https://example.com", "Recreate this website", "--rounds", "1"] }
craft_cli { "args": ["rebuild", "-", "A snake game in Rust", "--rounds", "1"] }
craft_cli { "args": ["doctor"] }
```

项目默认写到 `文档\Craft Anything`，可用 `--project-folder` 指定；`--project <x>.cany` 会让证据/日志持久化。

---

## 配置

`cordis.patch.yml` 里的两行都可调：

```yaml
- id: craft-anything-host
  name: dsh-craft-anything
  config:
    cliPath: 'C:\path\to\craft-anything-cli.exe'   # 覆盖 CLI 发现
    installDir: 'D:\craft-anything'                # 覆盖安装根目录
    projectDir: 'D:\craft-anything\work'           # craft_cli 的默认 cwd
    projectsRoot: 'D:\craft-anything\projects'     # 状态页显示
- id: craft-anything-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    # 其它 CLI 参数：CRAFT_ANYTHING_MCP_ARGS（例如 --all-tools；321 个工具的 schema ≈346 KB）
```

- CLI 发现顺序：`CRAFT_ANYTHING_CLI` → `<root>\bin\craft-anything-cli.exe` → `<root>\<版本>\craft-anything-cli.exe`。
- 模式文件：`<root>\mode.json`（`{"mode":"clean"}` / `{"mode":"deep"}`）；运行状态：`<root>\mcp.state.json`。
- 本机实测路径：`C:\Users\<你>\.dsh\plugins-data\craft-anything\v0.4.0\craft-anything-cli.exe`（portable 模式，设置在同目录 `CraftAnythingData\config.toml`）。

---

## 结构

```
dsh-craft-anything/
├─ package.json           # bundle 清单：dsh.bundle.patch + dsh.client（Web 半边）
├─ cordis.patch.yml       # 两行：Host 插件 + dsh-mcp-client（内嵌 Node 启动器）
├─ host/index.js          # craft_status / craft_cli / craft_install / craft_mode + HTTP 路由
├─ client.js              # 左侧栏图标 + 状态页 + 对话框左下角模式开关（纯 ESM，无需构建）
├─ locale/{en,zh}.json    # 插件显示名与描述
├─ icon.svg               # 原创图标
├─ dsh.plugin.json        # 插件市场可读的元数据
└─ scripts/install-cli.ps1# 下载/校验/解压官方 CLI
```

Host 半边只做三件事：读本地状态、跑本地 CLI、走 DSH 自带的 MCP 客户端；唯一联网行为是 `craft_install` 下载官方 release。

---

## 兼容性

| 项目 | 状态 |
|---|---|
| DSH **0.2.1-rc.2**（下限） | 逐包比对 npm 产物：`dsh-tools@0.2.1-rc.2` 与 rc.5 **byte-identical**（工具注册/JSON-Schema 校验同源）；`dsh-client-ui-slots` byte-identical；`dsh-mcp-client@0.2.1-rc.2` 仅在 resource-list 能力判断上有差异，**配置 schema（serverName/reconnect/toolCallTimeoutMs/failOnStartupError）完全一致** → 插件兼容 |
| DSH 0.2.2-rc1+ | 只用稳定 API，无私有字段依赖；未在 0.2.2-rc1 上真机跑过（该版本未在本机安装）。如果官方改了槽位或注册签名，插件会按 [RELEASING.md](RELEASING.md) 发新版本跟进 |
| Windows | 完整验证（CLI 安装、MCP、模式切换、状态页、发布脚本） |
| macOS | 启动器与安装器已按 macOS 适配（Electron-as-Node、universal CLI zip、SIGKILL 兜底）；**本机无 Mac，未做真机验证**——见下方「macOS 卡死」修复说明 |
| Linux | 安装器按 release tarball best effort；其余逻辑跨平台。未真机验证 |

### 性能

- 状态接口：缓存后 **~20 ms**（首次 ~100 ms），`?full=1` 强制重跑 CLI 探测约 **150 ms**；
- 模式接口：只读一个 JSON 文件，**~20 ms**；
- MCP 初始化：新增一次 `--version` 探测（约 40 ms），用于判断是否支持 `--clean-room/--deep`；
- 页面轮询：模式 60 秒、状态 5 分钟，且页面不可见时跳过；不再每 30 秒起两个 CLI 子进程。

---

### 环境与依赖卡怎么工作

- 检查项来自两个来源：插件自己的探测（CLI 版本、npm/命令是否存在）+ `craft-anything-cli engines_list`（引擎真实 found 路径，和 `doctor`/`capabilities` 同源）。
- **Ghidra**：如果本机已有 `GHIDRA_INSTALL_DIR`（或安装目录下的 `tools/ghidra_*`），一键安装不走 570 MB 下载，而是把它写进 CLI 设置（`settings_set engines.ghidra.install_dir`），几秒完成；没有现成 Ghidra 时才让 CLI 自己 `engines_install ghidra`（含 Java，耗时几分钟）。
- **Claude Code**：走 `npm install -g @anthropic-ai/claude-code`（Windows 用 npm 的 JS 入口，避免 `npm.CMD` 的 EINVAL）；装完还要执行一次 `claude` 登录或用 API Key，`rebuild` 才能用。
- 手动项（Java/GDB/Chromium）给出当前系统对应的命令（winget / brew / apt），点「复制命令」粘贴执行即可。

## MCP 桥按需开关与工具白名单（issue #1）

DSH 的 mcp-client 会把 stdio 服务器列出的每个工具都注册进上下文，所以默认 Essentials（30 个）或 `--all-tools`/深度（107/321 个）的 schema 会一直占 token。v0.4.0 增加了一个 MCP 代理（`scripts/mcp-bridge.cjs`）：

- 桥仍然默认开启、全部工具（升级后行为不变）；
- 页面「MCP 桥」卡里可以「关」桥、输入白名单（只支持 `*` 通配符）、或用预设（全部 / 仅核心 / 仅调查流程）；对话框左下角也有「桥 开/关」chip；
- 也可以用工具：`craft_bridge {"enabled": false}` 或 `craft_bridge {"allow": ["core_investigation_*","core_evidence_*"]}`；
- 状态存在 `<root>/bridge.json`（`{"enabled":true,"allow":[]}`），代理监听它并向 DSH 发 `notifications/tools/list_changed`，约 1 秒内上下文里的工具就增减完毕，**不需要重启 CLI、桥或 DSH**；
- 干净/深度模式切换仍会重启 CLI（上游模式在启动时固定），重启后自动沿用 `bridge.json`。

实测（0.2.1-rc.5 / craft-anything 0.5.0）：30 个工具 → 白名单后 5 个 → 关闭后 0 个（调用被拒）→ 重开 30 个，全程同一个 CLI pid。

> 白名单只裁剪 DSH 上下文里的 tool schema，不改变 CLI 内部工具集；要更多工具仍用 `mcp__craft__list_toolsets` / `enable_toolset`，或用白名单只挑常用组。

## 安全：管理接口鉴权

三条管理路由（`GET/POST /craft-anything/api/mode`、`GET /craft-anything/api/status`、`GET/POST /craft-anything/api/env`）
统一下了四层准入；未通过直接 401/403 且**不执行任何副作用**（不会跑 CLI、不会装依赖）：

1. **Host 头白名单**：只接受 `127.0.0.1` / `localhost`（含 `::1`）；Host 不是本机 → 403（防 DNS rebinding）。
2. **Origin 校验**：浏览器发来的请求，`Origin` 必须与请求的本地 authority 一致；跨站请求 → 403（防 CSRF，跨域 POST 一律拒绝）。
3. **宿主 connection 准入**：浏览器请求必须带 DSH 自己的会话凭据——`ctx.connection.requestRejection()` 复用宿主 DSH 的 Host/Origin/浏览器认证，未登录的浏览器请求 → 401。
4. **Bearer Token**：插件启动时用 `crypto.randomBytes(32)` 生成一次性随机 Token，所有管理请求必须带 `Authorization: Bearer <token>`，缺失或错误 → 401（比较用 `timingSafeEqual`）。

Token 的取得方式（**不需要用户输入密码或扫码**）：

- **页面自动引导**：状态页启动时 `GET /craft-anything/api/token`（该路由本身在 connection 准入之后）拿到 Token，之后所有 fetch 自动附带 Bearer；Token 轮换（插件重载）时遇到一次 401 会自动重新引导并重试。
- **本地脚本/CLI**：Token 同时写到 `<root>/http.token`（Unix 上 0600），直接读文件即可：

```powershell
$token = (Get-Content "$env:USERPROFILE\.dsh\plugins-data\craft-anything\http.token" -Raw).Trim()
curl.exe -H "Authorization: Bearer $token" http://127.0.0.1:51404/craft-anything/api/status
```

可用环境变量 `CRAFT_ANYTHING_HTTP_TOKEN`（≥32 字符）覆盖随机 Token，便于自动化测试；
Web UI 若确实要对外网/非回环地址提供服务，需显式放开（默认关闭）：
`config.allowNonLoopback: true` + `config.trustedHosts: ['myhost:51404']`，否则非回环 Host 一律 403。

## 排障 / 已知坑

**「macOS 上装完插件 DSH 卡死」已修复（v0.2.0）**
原因不是 UI，而是进程回收：启动器 `stop()` 只发一次 SIGTERM 且只靠 `child.on('exit')` 退出，而 `craft-anything-cli mcp` **故意忽略第一次 SIGTERM**（`main.rs:126-131` 只在第二次信号时 `exit(130)`；`crates/mcp/src/lib.rs:114-133` 的 serve 循环只认 stdin EOF），于是子进程不退、启动器不退、`dsh-mcp-client` 的卸载/重连一直等 → DSH 表现为卡死。Windows 上 `kill('SIGTERM')` 是 `TerminateProcess`，所以只有 macOS/Linux 暴露。修复：`SIGTERM → 150 ms 后再 SIGTERM → 1.2 秒 SIGKILL → 2.5 秒强制退出`，模式切换与信号两条路径共用同一套幂等兜底（deaf 子进程实验：旧逻辑 5 秒后仍存活，新逻辑 1.3 秒退出）。手动安装 CLI 的用户如果遇到 Gatekeeper 提示，对二进制执行 `xattr -d com.apple.quarantine craft-anything-cli`（`craft_install` 下载的文件不带 quarantine 属性）。

**其它已处理的问题**
- Finder 启动的 DSH 拿不到用户的 `node`：改用 DSH 自带的 Node（`!!js process.execPath` + `ELECTRON_RUN_AS_NODE=1`）。若构建关闭了 RunAsNode fuse，把该行 `command` 改成 `node`。
- 旧版 CLI 不认识 `--clean-room/--deep`：启动器先跑 `--version` 探测，旧版只传 `mcp`。
- `craft_cli` 超时/取消只发 SIGTERM，子进程不响应时 Promise 永不返回：现在 SIGKILL 升级 + 2.5 秒兜底 resolve。
- `CRAFT_ANYTHING_CLI` 指向旧路径时会遮蔽已安装的 CLI：现在回退扫描安装目录。
- 状态页/工具每次请求起两个 CLI 子进程：改为带 TTL 的缓存，`refresh`/`?full=1` 强制刷新。
- 插件反复重连看起来像卡住：`reconnect.maxAttempts` 改为 4、最大退避 5 秒，CLI 缺失时快速失败而不是重试几分钟。

**仍存在的限制**
- **模式切换 = 重启 MCP 服务**：上游 MCP 服务在启动时确定净室/深度，切换瞬间的在途调用会失败。
- **工具集默认只列 Essentials**：`--all-tools`（107 个）或深度 + 全量（321 个）的 schema 会显著增加每次请求的 token，按需开启。
- **`rebuild` 需要编码智能体**：本机未检测到 Claude Code / API Key 时，研究与证据类工具照常可用，`rebuild` 会明确失败（`craft-anything-cli doctor` 会说明缺什么）。
- **研究目标要合法**：只对你拥有或被允许检查的软件使用；上游不绕过 DRM、登录或反作弊。
- 插件市场检测依赖仓库里的 `dsh.plugin.json`、`package.json` 的 `dsh.bundle` / `keywords`（`dsh-plugin`、`deepseek-harness`）与 README；本仓库不发布到 npm。

---

## 许可

本仓库代码为 MIT（见 [LICENSE](LICENSE)）。Craft Anything 上游为 MIT OR Apache-2.0，商标与品牌归 ArtCraft Team；本插件未使用其商标或美术资源（图标为本仓库原创）。
