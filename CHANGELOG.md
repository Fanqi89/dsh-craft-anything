# 更新日志

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
