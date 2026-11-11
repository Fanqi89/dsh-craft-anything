# 更新日志

## [v0.6.0] - 2026-11-11

修复别人机器上一键安装依赖整片失败的问题，并按需求把下载改成"最快镜像优先、官方源兜底"，把原来只能复制命令的依赖也变成点一下就装。

### 修复

- **Windows 一键安装 CLI 报 `Invoke-WebRequest : InvalidOperation`（截图问题）**：`install-cli.ps1` 只用 `Invoke-WebRequest` 下载，在 TLS/代理/受限网络下直接抛错；现在优先用系统 `curl.exe`（`--retry`、超时、`--ssl-no-revoke`），没有 curl 才回退 IWR 并显式打开 TLS 1.2；错误信息不再因为 PowerShell 用 ANSI 代码页输出而变成乱码（Host 用 UTF-8 控制台包装执行，脚本自己设置 `[Console]::OutputEncoding`）。
- **最新版本解析有备用路径**：`api.github.com` 不通时改为读 `github.com/.../releases/latest` 的 302 Location（curl），两者都不通才提示用 `-Version vX.Y.Z`。
- **「Neither npm nor the Harness pnpm wrapper was found」**：pnpm 探测不再只看 `dirname(process.execPath)`，而是从 `process.resourcesPath`、`process.argv[1]` 里的 `resources/app.asar/...` 反推 Harness 安装目录；Windows 上两者都缺时先用 `winget install OpenJS.NodeJS.LTS` 装 Node，再用新装 npm 装 Claude Code；npm 安装走镜像/官方两个 registry 逐个重试。
- **Ghidra 的连锁失败**：CLI 装好后 Ghidra 的一键安装才有意义，本次随 CLI/npm 修复一起消失；Ghidra 仍优先复用本机安装。

### 新增

- **镜像源优先 + 官方兜底（GitHub 下载）**：新增 `scripts/mirrors.mjs`；默认候选 ghfast.top / gh-proxy.com / ghproxy.net / mirror.ghproxy.com，先对 `SHA256SUMS.txt` 发 range 请求测延迟，按最快排序、官方 github.com 永远排最后；每个候选下载后都要过 SHA256SUMS 校验，校验失败或下载不完整就换下一个源，全部失败才报错并列出每个源的失败原因。可用 `CRAFT_ANYTHING_GITHUB_MIRRORS` 覆盖候选（逗号分隔）。
- **npm registry 镜像**：`registry.npmmirror.com` 与官方 `registry.npmjs.org` 先测 `/-/ping` 延迟，快的先装、失败换下一个（可用 `CRAFT_ANYTHING_NPM_REGISTRY` 覆盖）。
- **复制命令 → 一键安装**：Chromium、Java、GDB 从"只能复制命令"改成 `auto: true`，Windows 走 winget（Chromium/Chrome、Temurin 21、MSYS2 里的 mingw gdb），macOS 走 brew，Linux 走 apt（必要时 sudo -n）；安装失败时页面上会同时出现「复制命令」按钮，不会变成死路。

### 验证

- `tests/install-cli/run.cjs` **12/12**（镜像改造后仍全绿，含 sha 不匹配、资产缺失、无 CLI、`CRAFT_ANYTHING_CLI` 短路、元数据失败回退）。
- 真实 v0.6.0 资产 dry-run：镜像测速后按顺序给出下载源，官方源兜底；所有候选都失败时会打印每个源的失败原因（本机实验：镜像不可达 → 直接落到 github.com）。
- `node --check`：host/index.js、client.js、scripts/install-cli.mjs、scripts/mirrors.mjs、restart-dsh.mjs、mcp-bridge.cjs 全部通过；PowerShell 脚本用 AST 解析 0 语法错误。

### 已知限制

- Ghidra 本体由上游 CLI 自己下载（`engines_install`），镜像只覆盖本插件自己的下载；上游 CLI 的下载源无法从插件侧替换。
- winget/brew/apt 属于系统包管理器，速度取决于它们的源，插件不代理；失败时仍给出复制命令。
- 镜像只是传输层：内容永远以 SHA256SUMS 为准，镜像无法替换成别的二进制。

## [v0.5.1] - 2026-11-11

v0.5.0 的更新/重启链路在两处边界上修正：多实例（独立 `DSH_HOME`）里的更新只动自己那个 profile；从命令行启动的 DSH 重启后仍然是同一条 CLI 服务，而不是弹出一个桌面窗口。

### 修复

- **更新会改错 profile（多实例）**：`findProfile()` 原来只看 `~/.dsh/profiles`，因此在独立 `DSH_HOME`（探针/测试实例）里点「立即更新」会去改默认 home 里的 profile。现在优先用 `DSH_HOME` 定位 profiles，更新只落在点击按钮的那个实例。
- **命令行启动的 DSH 重启成了桌面窗口**：`dsh web --profile X --port N` 是用 `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE` 跑 `cli.js`，`process.execPath` 是 app 二进制；原启动命令只写回 `[exe]`，重启会打开 GUI。现在识别 CLI 模式，用 `[exe, cli.js, --profile X, …原参数]` 重新拉起，并避免重复追加已经在 argv 里的 `--profile`（重复会让 commander 直接退出）。
- **第二次重启被误拒**：helper 成功后没有清理 `<root>/restart.pending.json`，120 秒内的下一次重启会被当成"已在重启中"。现在把 pending marker 传给 helper，成功拉起后删除。

### 验证

- 探针实例（独立 `DSH_HOME`、隔离插件数据 root、端口 51235）走完整页面链路：0.4.0 副本 → 「检查更新」显示 **有新版本 v0.5.0** → 弹窗「先 v0.4.0 → v0.5.0 + 更新说明」→ 「立即更新」→ pnpm 安装 **49.8 s**、profile 依赖变为 `github:Fanqi89/dsh-craft-anything#v0.5.0` → 自动弹出「重启 DeepSeek Harness？」→ 「立即重启」→ `restart.log` 记录 `the Harness stopped` / `relaunched pid 6980`，新进程在同一端口监听（HTTP 401 = 服务已起），profile 仍为 `probe`。
- 回归：桥 `41/41`、安装器 `12/12`、重启 helper（stand-in 进程，含 pid 已消失路径）全绿、`tests/update/check.mjs` 全绿。

### 已知限制

- 重启后端口可能变化；桌面版会重新打开窗口，CLI 版沿用原端口（若端口被占用则新进程会换端口，日志里能看到）。
- 走 GitHub 的更新仍需要 GitHub 可达（直连或 `HTTPS_PROXY`/`env.json`）。

## [v0.5.0] - 2026-11-11

回应 B 站实测视频（BV13n4J6yEhY）与来信里提到的两个问题：模式切换不再打断在途调用、Linux/macOS 一键安装 CLI 修好（并支持手动指定 CLI 路径）；同时按需求在环境卡加了「检查更新」按钮：查 GitHub 最新版本 → 一键安装 → 询问是否重启 DSH。

### 修复

- **模式切换打断在途调用（来信 1）**：v0.4.0 及以前写 `mode.json` 后启动器直接退出，`dsh-mcp-client` 重连，切换瞬间正在执行的 `tools/call` 会失败、工具列表短暂消失。v0.5.0 把 `scripts/mcp-bridge.cjs` 改成常驻的 MCP stdio 服务：检测到模式变化后先 drain 已转发未回包的请求（默认最多 20 秒，`CRAFT_ANYTHING_DRAIN_MS` 可调），期间的请求排队，然后按原有「双 SIGTERM → SIGKILL → 2.5 秒兜底」只替换 CLI 子进程，自己完成新子进程的 `initialize`/`initialized`/`tools/list` 握手（内部 id 永不下发 DSH），按原 id 重放排队与超时请求，最后发 `notifications/tools/list_changed`。**DSH 不重连、在途调用照常拿到结果**；子进程意外退出也会自动重拉，没有子进程时请求返回 `-32603` 而不是挂死。
- **Linux 一键安装 CLI 报错（视频 1）**：v0.1.x 的 `package.json#files` 根本没打包 `scripts/install-cli.mjs`，非 Windows 上 `runCliInstaller()` 只会抛 "installer script is missing"（视频里的现象）。`install-cli.mjs` 重写为：从 release 元数据解析资产名（`craft-anything-<ver>-linux-{x86_64,aarch64,riscv64}.tar.gz` / macOS universal zip，元数据失败时回退构造名）、SHA256SUMS 强校验、递归查找任意嵌套目录里的 `craft-anything-cli`（优先）或 `craft-anything`、每个失败路径都给出可复制的回退命令；`CRAFT_ANYTHING_CLI` 已指向可用 CLI 时直接返回（不下载）。
- **Linux 模式开关不生效（视频 2）**：视频测的是 v0.1.x，当时启动器只发一次 SIGTERM 而 CLI 故意忽略第一次；v0.2.0 已改成双 SIGTERM + SIGKILL + 2.5 秒兜底。v0.5.0 的桥内热切换进一步不再依赖 DSH 重连，三个平台走同一代码路径。
- `dsh.plugin.json` 补上 v0.4.0 漏登记的 `craft_bridge` 工具。
- 页面「CLI 路径」写入的 `CRAFT_ANYTHING_CLI` 现在参与 Host 的 CLI 发现（以前只影响子进程）。

### 新增

- **检查更新（页面按钮）**：环境与依赖卡顶部、「一键补齐可自动项」右边新增「检查更新 / Check for updates」，显示当前版本；点击查 GitHub 最新 Release，有新版本弹出确认框（当前 → 最新、Release 说明），确认后在插件所在 profile 里执行 `dsh plugin --profile <p> add github:Fanqi89/dsh-craft-anything#v<tag> --config.minimumReleaseAge=0`（固定标签），完成后弹「是否重启 DSH」，点是则由分离 helper 结束主进程并重新拉起。路由：`GET/POST /craft-anything/api/update`、`POST /craft-anything/api/restart`，与既有路由同一套鉴权。无网/限流/找不到 profile 只影响报告，不会改动已安装版本。
- **环境卡「CLI 路径」输入框**：把已有 `craft-anything-cli` 的路径写进 `<root>/env.json`，Host 发现、安装器、MCP 启动器统一生效。
- **上下文开销提示**：桥卡显示 `visible / total` 与估算 token；>60 个工具时提示可点「仅核心 / 仅调查流程」收窄。
- 桥的 `mcp.state.json` 增加 `switching`、`pendingCalls`、`restarts`、`lastSwitchAt`、`lastRestartReason`；`GET /api/bridge` 同步返回切换状态；写入 `<root>/mcp.restart` 会用同一模式重启子进程（重装 CLI 后自动生效）。

### 兼容性

- `engines.dsh` 仍为 `>=0.2.1-rc.2`；新代码只用既有 `webServer` / `connection` / 工具注册 API。
- 桥的 `start()` 签名、`bridge.json` 语义、导出都不变，`cordis.patch.yml` 的启动器无需修改。
- 更新走 DSH 自带 CLI（`<app>/resources/app.asar/.../dsh-desktop-host/lib/cli.js` + `ELECTRON_RUN_AS_NODE`），不要求 PATH 上有 `dsh`；可用 `CRAFT_ANYTHING_DSH_CLI` 覆盖。

### 验证

- 桥：`node tests/bridge/run.cjs` **41/41**（5 次连跑全绿）：切换期间在途调用照常返回、期间的请求排队后被重放、桥 pid 全程不变、内部 id 零泄漏、`list_changed` 只发一次、drain 超时后同 id 重放且只回答一次、无子进程时 `-32603`、`mcp.restart` 重启同模式、`bridge.json` 过滤/关闭/恢复；真实 CLI 冒烟 clean 30 → deep 38 → clean 30（225/228 ms，桥 pid 不变）。
- 安装器：`node tests/install-cli/run.cjs` **12/12**（Linux tar.gz 嵌套 FHS 布局、macOS zip、SHA256 不匹配、资产缺失、SHA256SUMS 缺项、无 CLI、`CRAFT_ANYTHING_CLI` 短路、元数据失败回退、`--dry-run`、缺 curl、`--force`）；真实 v0.6.0 API dry-run 解析出 `craft-anything-0.6.0-linux-x86_64.tar.gz` / `craft-anything-cli-0.6.0-macos-universal.zip`。
- 更新：`node tests/update/check.mjs` 全绿（版本比较、GitHub 最新 Release、profile 发现）；`tests/update/install-probe.mjs` 用真实 DSH CLI + pnpm 把 **v0.4.0** 装进一次性 profile（34.1 s）：profile 依赖变为 `github:Fanqi89/dsh-craft-anything#v0.4.0`、`node_modules` 里包版本 0.4.0、`update.state.json` 落盘；`node tests/restart/run.mjs` 对 stand-in 进程验证「停旧进程 → 等退出 → 拉起新进程 → 清理 pending 标记」，含 pid 已消失的路径。
- 页面：中英文、检查更新弹窗、更新进度、重启询问、CLI 路径输入框在 DSH 0.2.1-rc.5 真机页面验证（截图见 PR/发布说明）。

### 已知限制

- 超时未完成的调用会在新子进程上以同一 id 重放：read-only 工具，理论上可能重复执行一次（换来的是不再报错）。
- 桥内部握手固定 `protocolVersion 2025-06-18`（`dsh-mcp-client` 协商的版本）；DSH 侧自己的 initialize 仍是客户端原始消息。
- 一键更新依赖 GitHub 可达（走系统代理环境变量或 `env.json`）；完全离线时只能手动 `dsh plugin add`。
- 重启会更换 Web 端口，当前页面需要重新打开；进行中的 agent 回合会中断。
- 本机无 Linux/macOS，安装器的非 Windows 分支用 `--platform` 交叉验证（资产解析、下载、校验、解包、安装、失败路径），**未执行真实 Linux/macOS 二进制**。

## [v0.4.0] - 2026-11-08

MCP 桥按需连接：新增桥开关与工具白名单（回应 issue #1「避免 300+ 工具常驻上下文」）。功能行为不变，新增的是可控性。

### 新增

- **MCP 代理（`scripts/mcp-bridge.cjs`）**：启动器不再把 stdio 直接透传给 `craft-anything-cli mcp`，而是经过一个 JSON-RPC 代理。代理按 `<root>/bridge.json` 过滤 `tools/list`（隐藏不在白名单里的工具），并对被隐藏工具的 `tools/call` 直接返回错误。
- **动态重同步、不重启**：`bridge.json` 变化时代理向 DSH 发 `notifications/tools/list_changed`；`dsh-mcp-client` 订阅该通知并重新 `listTools()`（其 SDK 的 `onChanged → refreshTools`），约 1 秒内上下文里的 `mcp__craft__*` 工具就增减完毕。**CLI、桥进程与 DSH 都不重启，pid 不变**。
- **`craft_bridge` 工具**：`{enabled?, allow?}` 设置或读取状态，返回可见/总数；`allow` 是只支持 `*` 的通配符列表，空数组=全部工具。
- **页面与输入栏控制**：MCP 桥卡新增「MCP 桥开关（开/关）+ 工具计数（visible/total）+ 工具白名单输入框 + 保存 + 预设（全部工具 / 仅核心 / 仅调查流程）」；对话框左下角新增「桥 开/关」chip（order 84，紧邻净室/深度模式开关），中英文双语。
- 新增 HTTP 路由 `GET/POST /craft-anything/api/bridge`（与 status/mode/env 一样受鉴权守卫）。

### 设计说明

- 默认仍是**开启且全部工具**，升级后行为不变；需要省 token 的用户在页面点「关」或用白名单裁剪即可，也可以写 `bridge.json`。
- 白名单只影响 DSH 上下文里注册的 tool schema，不改变 CLI 内部工具集；需要更多工具时仍用 `mcp__craft__list_toolsets` / `enable_toolset`，或用 allow 白名单挑常用组。
- 干净/深度模式切换仍会重启 CLI（上游模式在启动时固定），重启后代理自动重新读 `bridge.json`。

### 兼容与回退

- Host 半在 apply 时把代理写到 `<root>/mcp-bridge.cjs`；启动器最多等 5 秒加载它，加载失败则回退旧的直连方式（升级时序不会把桥弄坏）。
- `engines.dsh` 仍为 `>=0.2.1-rc.2`；只用 mcp-client 已支持的 `notifications/tools/list_changed` 与 stdio JSON-RPC。

### 验证

- 独立 node 测试（真实 craft-anything-cli 0.5.0）：initialize/tools/list 30 → 白名单 `core_investigation_*,core_evidence_*` 后 5 个、收到 `list_changed` → 关闭后 0 个且 `tools/call` 被拒 → 重开 30 个；mode.json 改动后进程以 0 退出。
- DSH 真机（0.2.1-rc.5）：`craft_bridge` 设白名单后 `mcp.state.json` 记录 `tools:{total:30,visible:5}`；关闭后工具从上下文消失（调用报 unknown tool），重开后恢复 30 个；两次变更 pid 均保持 8268（未重启）。页面「仅调查流程」预设点击后 visible=18，恢复「全部工具」后 30/30。

### 已知限制

- 代理是行分帧的 JSON-RPC 转发，不解析工具内容；极大的 `tools/list`（321 工具约 350KB 单行）仍会一次性缓冲，但正常使用无影响。
- 白名单匹配只支持 `*`（不支持 `?`/正则）；大小写不敏感。

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
