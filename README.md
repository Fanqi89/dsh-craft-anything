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
| **模式切换（净室 ⇄ 深度）** | DSH 对话框左下角工具行里的下拉开关（「净室模式 / 深度模式」，紧邻其它插件的模式开关但不重叠）；也可用 `craft_mode` 工具切换。切换会写入 `mode.json` 并重启 MCP 服务进程，`dsh-mcp-client` 自动重连，工具列表 1–2 秒内在新模式重新同步。 |
| **状态工具** `craft_status` | CLI 路径/版本、是否 portable、工具集与工具数量、可用引擎（chromium/gdb/java/objdump…）、Ghidra 与编码智能体是否就绪、MCP 连接方式。 |
| **命令运行器** `craft_cli` | 以参数数组直调 CLI（无 shell）：`rebuild`、`doctor`、`setup`、`report`、`triage`、`commands`、`capabilities` 等。长任务可放大 `timeoutMs`，取消时子进程会被杀掉。 |
| **安装器** `craft_install` | 从 GitHub Releases 下载官方 Windows portable 包到 `%USERPROFILE%\.dsh\plugins-data\craft-anything\<版本>\`，**解压前校验 SHA256**（对照 release 的 `SHA256SUMS.txt`），已安装则秒回。 |
| **状态页** | 左侧栏「Craft Anything」图标 → 中央面板显示本地安装、能力、MCP 桥与常用命令；数据来自插件自己的 `GET /craft-anything/api/status`。 |

截图（DSH 对话框左下角的模式开关、左侧栏入口、状态页）见仓库 Releases / 使用说明；界面文字与状态实时读取本机。

---

## 安装

### 前置

- DeepSeek Harness 桌面版 **0.2.0-rc.2 或更新**（`package.json` 的 `engines.dsh` 与 `dsh.plugin.json` 都声明 `>=0.2.0-rc.2`；依赖它自带的 `@deepseek-ai/dsh-mcp-client`）。
  - Host 侧（MCP 桥、四个工具、HTTP 路由）在 0.2.0-rc.2 起的版本可用；
  - 界面侧（左侧栏入口、状态页、对话框左下角模式开关）在 0.2.1-rc.5 上真机验证过；更老的 Harness 若没有对应槽位，这几块**自动不出现**，其余功能不受影响。
- Node.js ≥ 22（MCP 启动器用 `node -e` 运行，DSH 自带 Node 亦可）。
- 想用 `rebuild` 的话另需一个编码智能体（如 Claude Code）或 API Key；只做「研究/分析」不需要。
- Windows 下 `craft_install` 会自动下载 CLI；macOS/Linux 请自行安装 CLI 后设置 `CRAFT_ANYTHING_CLI`。

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

## 已知限制

- **自动安装仅 Windows**：下载的是官方 `windows-x64-portable` 包；其它平台请按上游 README 安装后设置 `CRAFT_ANYTHING_CLI`。
- **模式切换 = 重启 MCP 服务**：上游 MCP 服务在启动时确定净室/深度，插件靠「写模式文件 → 启动器退出子进程 → dsh-mcp-client 重连」实现切换；切换瞬间的在途调用会失败。
- **工具集默认只列 Essentials**：`--all-tools`（107 个）或深度 + 全量（321 个）的 schema 会显著增加每次请求的 token，按需开启。
- **`rebuild` 需要编码智能体**：本机未检测到 Claude Code / API Key 时，研究与证据类工具照常可用，`rebuild` 会明确失败（`craft-anything-cli doctor` 会说明缺什么）。
- **研究目标要合法**：只对你拥有或被允许检查的软件使用；上游不绕过 DRM、登录或反作弊。
- 插件市场检测依赖仓库里的 `dsh.plugin.json`、`package.json` 的 `dsh.bundle` / `keywords`（`dsh-plugin`、`deepseek-harness`）与 README；本仓库不发布到 npm。

---

## 许可

本仓库代码为 MIT（见 [LICENSE](LICENSE)）。Craft Anything 上游为 MIT OR Apache-2.0，商标与品牌归 ArtCraft Team；本插件未使用其商标或美术资源（图标为本仓库原创）。
