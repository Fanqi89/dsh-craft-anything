# 更新日志

## [v0.3.1] - 2026-11-08

安全修复：Web 管理接口接入宿主认证 + Bearer Token + Host/Origin 双校验。功能行为不变。

### 修复（安全审查意见）

- **管理接口无鉴权**：`/craft-anything/api/status`、`/mode`、`/env` 之前任何人都能直接 GET/POST（包括触发 CLI 依赖安装的 `POST /api/env {"action":"install"}`）。现在三条路由统一走 `guarded()`：
  - **Host 头**只接受 `127.0.0.1` / `localhost` / `::1`，否则 403（防 DNS rebinding）；
  - **Origin** 必须与本地 authority 一致，跨站（含跨域 POST）→ 403（防 CSRF）；
  - **宿主 connection 准入**：浏览器请求必须通过 `ctx.connection.requestRejection()`（复用 DSH 的 Host/Origin/浏览器会话认证），未认证 → 401；
  - **Bearer Token**：启动时 `crypto.randomBytes(32)` 生成，`Authorization: Bearer <token>` 缺失/错误 → 401，比较用 `timingSafeEqual`。
- **Token 下发（无用户输入）**：新增 `GET /craft-anything/api/token`（本身在 connection 准入之后），状态页自动引导并缓存；Token 同时写入 `<root>/http.token`（0600）供本地 CLI 使用；支持 `CRAFT_ANYTHING_HTTP_TOKEN`（≥32 字符）覆盖。
- **新增配置**：`trustedHosts`（默认空）与 `allowNonLoopback`（默认 false），只有显式放开时才接受非回环 Host；默认严格回环。
- 前端（[client.js](client.js)）：新增 `fetchToken()` + `apiFetch()`，所有 status/mode/env 请求自动带 Bearer 并带 `credentials: same-origin`；401 时重新引导并重试一次（覆盖插件重载导致的 Token 轮换）。

### 验证（Windows，DSH 0.2.1-rc.5，真机）

- 无鉴权 `GET /api/status` → **401**；无鉴权 `POST /api/mode` → **401**（不再触发模式切换或安装）；
- 正确 Bearer → **200**；错误 Token → **401**；`Origin: https://evil.example` → **403**；`Host: evil.example` → **403**；
- 状态页（中文/英文）在浏览器里照常加载环境卡、本地安装、MCP 桥；页面内切换模式到深度再切回净室成功（浏览器 POST 带 Bearer + DSH cookie 通过）；
- Token 文件 64 hex 字符、位于 `<root>/http.token`。

### 兼容性

- 仍为 `engines.dsh >=0.2.1-rc.2`：`@deepseek-ai/dsh-client-connection` 的 `requestRejection/admit` 在 0.2.1-rc.2 与 rc.5 都存在（且 rc.2 与 rc.5 该包内容一致）。
- 非 Web profile（无 `webServer`）时路由不注册，工具不受影响；`connection` 服务缺失时浏览器请求一律 401（fail-closed），非浏览器请求仍需 Bearer。

## [v0.3.0] - 2026-11-07

页面双语 + 环境与依赖一键补齐。功能行为与 v0.2.0 相同，新增的是界面能力和安装自动化。

### 新增

- **中英文切换**：页面右上角「中文 / English」分段开关，切换标题/说明/本地安装/MCP 桥/工作流命令/环境与依赖全部文案，以及模式菜单与对话框左下角模式开关；选择存 localStorage，首次打开跟随浏览器语言。中文文案包含模式菜单、状态说明、环境提示与按钮。
- **环境与依赖卡（按操作系统检查 + 一键补齐）**：
  - 检查项：craft-anything CLI、Chromium 内核浏览器、Claude Code 编码智能体、Ghidra、Java 21+、GDB；核心 / 深度模式两组。
  - 判定来源：插件探测 + `craft-anything-cli engines_list --json`（与 `doctor`/`capabilities` 同源的 found 路径），结果缓存 2 分钟，页面「刷新」走 `?full=1` 强制重查。
  - 自动项：CLI（复用 v0.2.0 安装器）、Claude Code（`npm install -g @anthropic-ai/claude-code`，Windows 走 npm 的 JS 入口避开 `npm.CMD` 的 spawn EINVAL；npm 缺失时回退 DSH 自带 pnpm）、Ghidra（优先把现成 `GHIDRA_INSTALL_DIR` / `tools/ghidra_*` 通过 `settings_set engines.ghidra.install_dir` 写进 CLI，几秒完成；没有现成安装才让 CLI `engines_install ghidra` 下载 Ghidra+Java）。
  - 手动项：Java / GDB / Chromium 给出当前系统命令（winget / brew / apt），「复制命令」一键复制。
  - 后台任务：POST 立即返回 job，页面 2.5 秒轮询显示进度日志与失败原因；安装完成自动刷新状态卡与检查项；顶部「Install all fixable / 一键补齐可自动项」一次处理全部缺失自动项。
- 新增 HTTP 路由 `GET/POST /craft-anything/api/env`（GET 返回检查项+job 快照，POST `{"action":"install","id"}` 或 `{"action":"fix-all"}`）。

### 修复

- 环境接口首次实现时 `report.noteCodes` 未初始化，GET /api/env 返回 500（`Cannot read properties of undefined (reading 'push')`）——已初始化并按需写入，状态工具输出保持英文 notes 不变。
- `npm.CMD` 在 Node 下直接 spawn 报 `EINVAL`，经 `cmd.exe` 又因 /s 去引号失败——改为用 DSH 自带 Node 执行 `node_modules/npm/bin/npm-cli.js`，实测安装 Claude Code 成功并出现在 PATH（`%APPDATA%\npm\claude.CMD`）。
- 页面「刷新」现在绕过 engines 缓存；环境任务完成后自动刷新本地安装卡。

### 兼容性

- `engines.dsh` 仍为 `>=0.2.1-rc.2`；新代码只用既有 API（`ctx.inject(['webServer'])` 路由、普通 Client ESM），0.2.1-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.1 均适用。
- 本机实测：DSH 0.2.1-rc.5 + craft-anything 0.5.0，Windows：环境卡 6/6 就绪；Ghidra「缺失 → 点击 Install → 已就绪」真机点击验证；Claude Code 后台安装完成；中英文切换与页面持久化真机验证。

### 已知限制

- Ghidra 的 `engines_install`（无现成安装时的 570 MB 下载 + 自带 Java）本次未在本机完整跑通——本机已有 `C:\tools\ghidra_12.1.4_PUBLIC`，走的是「复用现成安装」路径；下载路径按 CLI 自身工具实现编写，需在无 Ghidra 的机器上再验一次。
- macOS/Linux 的自动安装（npm/pnpm、`settings_set`）未真机验证；命令均按平台分支编写。
- Claude Code 安装完成后仍需登录（`claude`）或配置 API Key，`rebuild` 才能使用；npm 可能提示 `allow-scripts`（claude 的 postinstall 未跑），如遇原生依赖缺失可手动放行一次。

## [v0.2.0] - 2026-11-07

稳定性、跨平台与性能版本：修掉 macOS 上安装/启用本插件会把 DSH 卡死的问题，补齐 macOS/Linux 的 CLI 安装，并针对 DSH **0.2.1-rc.2（新下限）** / 0.2.1-rc.5 / 0.2.2-rc.1 做兼容性与性能核对。插件功能与 v0.1.x 相同。

### 修复

- **macOS 装完插件 DSH 卡死**（根因是进程回收，不是 UI）：启动器 `stop()` 只发一次 SIGTERM，且唯一的退出路径是 `child.on('exit')`；而 `craft-anything-cli mcp` **故意忽略第一次 SIGTERM**（`apps/craft-anything-cli/src/main.rs:126-131` 只在第二次信号 `process::exit(130)`，`crates/mcp/src/lib.rs:114-133` 的 serve 循环只认 stdin EOF、从不检查中断标志），于是子进程不退、启动器不退、`dsh-mcp-client` 的卸载/重连一直等 → DSH 看起来卡死。Windows 的 `kill('SIGTERM')` 是 `TerminateProcess`，所以只有 macOS/Linux 暴露。修复：`SIGTERM → 150 ms 后再 SIGTERM（让 CLI flush 退出）→ 1.2 s SIGKILL → 2.5 s 强制退出`，模式切换与信号两条路径共用同一套幂等兜底。已用「deaf 子进程」实验验证：旧逻辑 5 s 后仍存活，新逻辑 1.3 s 退出。
- **`craft_cli` 超时/取消可能挂死**：同样只发一次 SIGTERM，子进程不响应时 Promise 永不返回（`toolCallTimeoutMs` 默认 10 分钟 → 表现为长时间卡住）；现在双 SIGTERM + SIGKILL + 2.5 s 兜底 resolve，超时一定返回。
- **Finder 启动的 DSH 找不到 `node`**：`command` 改为 `!!js process.execPath` + `ELECTRON_RUN_AS_NODE=1`，直接使用 DSH 自带的 Node（三平台一致）。若构建关闭 RunAsNode fuse，可把该行 `command` 改成 `node`。
- **旧版 CLI 不认识模式参数**：启动器先跑 `--version` 探测，`< 0.4.0` 只传 `mcp`，避免退出/重连循环。
- **坏 `CRAFT_ANYTHING_CLI` 遮蔽已安装 CLI**：现在回退扫描安装目录（`bin/` 与版本目录）。
- **状态页/工具每次请求起两个 CLI 子进程**：`--version` 缓存 5 分钟、`capabilities` 缓存 10 分钟；`craft_status {refresh:true}` 与 `GET /craft-anything/api/status?full=1` 强制刷新。
- **重连像卡死**：`reconnect` 从 10 次/最长 30 s 退避降为 4 次/最长 5 s，CLI 缺失时快速失败。
- `which()` 查找加 60 s 缓存（冷路径原来两次各 ~30 ms）。

### 新增

- **安装后自动重启桥**：`craft_install` 成功后写 `mcp.restart` 标记，启动器轮询到就把 MCP 服务重启到新 CLI（不需要重开 DSH）；`craft_status` 会显示桥当前运行的 CLI 版本，主机工具与桥版本不一致时给出提示。\n- **macOS 安装 CLI**：`craft_install` 在 macOS 下载官方 `craft-anything-cli-<ver>-macos-universal.zip`，校验 SHA256 后解压到 `~/.dsh/plugins-data/craft-anything/<ver>/` 并放一份到 `bin/`。新增 `scripts/install-cli.mjs`（Node，无 PowerShell 依赖；Windows 仍走已验证的 `install-cli.ps1`；Linux 按 release tarball best effort）。
- README 增加「兼容性」「性能」「排障 / 已知坑」三节。

### 兼容性核对

- **DSH 0.2.1-rc.2（下限）**：npm 产物比对——`dsh-tools@0.2.1-rc.2` 与 rc.5 **byte-identical**（sha `1E53932E7C42…`，工具注册与 JSON-Schema 校验同源）；`dsh-client-ui-slots` byte-identical（sha `57E1314E31A2…`）；`dsh-mcp-client@0.2.1-rc.2` 与 rc.5 仅差 resource-list 能力判断（35041 vs 35189 B），**配置 schema 字段完全一致**。
- **DSH 0.2.2-rc.1（2026-11-04 发布）**：逐文件比对 npm 包，`dsh-mcp-client`、`dsh-client-ui-slots` 的代码 **byte-identical** 于 0.2.1-rc.5；槽位 `sidebar.panellist` / `main` / `conversation.input.left` 的 kind+scope 与工具注册/JSON-Schema 校验在三代版本中一致；`dsh-tools` 内部重构（新增 `./pipeline`、移除 `./types`）不影响本插件——`host/index.js` 只 import `node:*`。结论：**无需为 0.2.2-rc.1 改动**。
- **兼容下限提高到 `>=0.2.1-rc.2`**（按需求修正；`dsh.plugin.json` 与 `package.json` 一致）。`engines.dsh >=0.2.1-rc.2` 对 0.2.2-rc.1 仍成立：DSH 用 `semver.satisfies(..., { includePrerelease: true })` 判断，普通 semver 会误判为不满足——不要"修正"这个范围。
- **Craft Anything CLI 0.5.0（2026-11 上游新版）**：`craft_install` 实际下载 0.5.0 官方 Windows portable（sha256 `45dbe3420d6254aa39ab8e15160a09539dd241ac1d1cc20fec9e7b175654a1fc`）验证通过，321 工具/17 工具集，`mcp --clean-room` 与 `--deep` 行为与 0.4.0 一致；本插件对 0.4.0/0.5.0 都按版本探测决定是否传模式参数。\n- **`react-dom` 可用**：DSH 前端模块表在 0.2.1-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.1 都把 `react`、`react-dom`（18.3.1）列为种子模块，模式菜单的 `createPortal` 安全（代码仍保留无 portal 回退）。

### 性能（Windows，0.2.1-rc.5 实测）

- `GET /api/status`：热 **~26 ms**；TTL 过期但探测缓存仍热 ~49–93 ms；`?full=1` 强制刷新 p50 **324 ms**（`--version` 24–58 ms + `capabilities` 103–164 ms）。
- `GET /api/mode`：~33 ms（只读 JSON）。
- 状态页轮询：模式 60 s、状态 5 min，页面不可见时跳过；不再每 30 s 起两个子进程。
- MCP 初始化：启动→initialize 70–111 ms，多一次 `--version` 探测约 40 ms。
- 工具 schema 体积（宿主侧）：4 个 `craft_*` 工具 2,896 字符（0.72%）；开销主要在 MCP 侧默认 30 工具（~8.1k tokens）。

### 已知限制

- macOS/Linux 的 CLI 安装与运行未做真机验证（本机只有 Windows）：macOS 安装包已用官方 zip 在 Windows 上完成下载+校验+解包+布局检查（Mach-O universal，64,984,464 B，sha256 `37aef822bbe43ec2b3b9810ff00f4d38c922c6ac33d0cae8427eb83086fed3aa`），但"能否在 Mac 上执行"需 Mac 实测。
- 模式切换会重启 MCP 服务，切换瞬间在途调用失败。
- `rebuild` 需要本机有编码智能体（如 Claude Code）或 API Key。
- `--all-tools`（107）或深度 + 全量（321）会显著增加每次请求的 token。

## [v0.1.1] - 2026-11-06

发布工程与兼容性说明（插件运行行为不变，与 v0.1.0 功能一致）。

### 变更

- **兼容下限明确为 `>=0.2.0-rc.2`**：`package.json` 与 `dsh.plugin.json` 的 `engines.dsh` 一致声明该下限；Host 侧（MCP 桥、四个工具、HTTP 路由）自 0.2.0-rc.2 起可用，界面侧在 0.2.1-rc.5 真机验证，缺少槽位的更老版本会自动隐藏界面而不报错。
- **发布流程固化**：新增 `RELEASING.md`（版本号唯一、标签不可移动、旧版本永久可装）与 `scripts/release.ps1`（校验版本/engines/语法/工作树 → 拒绝重复或倒退的版本号 → 附注标签 → 推送 → 建或更新 GitHub Release → 回读自证）。
- **多版本共存**：每个版本独立标签与 Release，`github:Fanqi89/dsh-craft-anything#vX.Y.Z` 可安装任意历史版本，`main` 始终是最新。

## [v0.1.0] - 2026-11-06

首个公开版本。

### 新增

- **MCP 桥**：通过 DSH 自带的 `@deepseek-ai/dsh-mcp-client` 连接本机 `craft-anything-cli mcp`，工具以 `mcp__craft__*` 注册；默认 Essentials（30 个工具），深度模式 38 个，运行时可用 `list_toolsets` / `enable_toolset` 加载更多工具集。
- **净室 / 深度模式切换**：对话框左下角工具行里的下拉开关（圆点 + 文字 + ▴，菜单含说明与 ✓），另有 `craft_mode` 工具；切换写 `mode.json` → MCP 启动器重启服务 → `dsh-mcp-client` 自动重连并刷新工具列表。
- **Host 工具**：`craft_status`（安装/能力/引擎/编码智能体/MCP 状态）、`craft_cli`（参数数组直调 CLI：`rebuild`/`doctor`/`report`…）、`craft_install`（下载官方 Windows portable 包，**解压前校验 SHA256**）、`craft_mode`。
- **状态页**：左侧栏「Craft Anything」入口 + 中央面板（本地安装、能力、MCP 桥、常用命令），数据来自 `GET /craft-anything/api/status`。
- **插件市场元数据**：`dsh.plugin.json`、`dsh.bundle` 清单、`keywords`（`dsh-plugin`、`deepseek-harness`）。

### 兼容性

- `engines.dsh`：`>=0.2.0-rc.2`。Host 侧（MCP 桥、工具、路由）自 0.2.0-rc.2 起可用；界面侧（侧栏、状态页、模式开关）在 0.2.1-rc.5 上真机验证，缺少对应槽位的更老版本会自动隐藏这三块而不报错。
- Craft Anything CLI：0.4.0（官方 Windows x64 portable，sha256 `6edc07cda83c9ca75fcc0f08db9ffedaef89094faf4d9713b52b299be4c397e1`）。

### 已知限制

- 自动安装 CLI 仅 Windows；其它平台需自行安装并设置 `CRAFT_ANYTHING_CLI`。
- 模式切换会重启 MCP 服务，切换瞬间在途调用失败。
- `rebuild` 需要本机有编码智能体（如 Claude Code）或 API Key。
- `--all-tools`（107）或深度 + 全量（321）会显著增加每次请求的 token。
