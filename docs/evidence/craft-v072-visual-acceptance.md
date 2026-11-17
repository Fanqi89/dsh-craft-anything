# dsh-craft-anything v0.7.2 视觉验收（真实界面）

补上 v0.7.0 设置页、v0.7.1 / v0.7.2 输入框配色说明里「像素级观感尚未验收」的缺口：重启 DSH 后在真实界面里逐项看过并做了像素采样。

## 环境

- 2026-11-17 21:2x（Asia/Shanghai），Windows 10，DSH desktop（Electron），1366×768、DPI 100%、**浅色主题**。
- 插件：v0.7.2，profile 为 `link:C:/Users/fanqi/Desktop/dsh-craft-anything`（重启后加载源码）。
- 版本自证：`GET /craft-anything/api/update` → `current.version = "0.7.2"`；`GET /craft-anything/api/ui` → 200，`ui.source = {composerMode:"settings", composerBridge:"settings"}`。

## 结果

| 检查项 | 结果 |
|---|---|
| 设置 → Craft Anything 分区存在 | ✅ 侧栏出现「Craft Anything」，页面标题「输入框开关」 |
| composer 两个 chip 为纯文本样式 | ✅ 无边框、无底色；「桥 关」「净室模式」都是 6px 圆点 + 文字 |
| 默认（桥关 / 净室）安静 | ✅ 两个点均为灰 `(233,233,233)`，截图无琥珀像素 |
| 桥开 → 琥珀点 | ✅ 点「桥 关」后 label 变「桥 开」，桥点采样 `(245,158,11)` = `#F59E0B`（DSH warn token），并出现「工具已更新 · 新增 30 个」 |
| 深度模式 → 琥珀点 | ✅ 模式下拉正常弹出（净室 / 深度 + 说明 + ✓），选深度后模式点 `#F59E0B`、桥点保持灰 |
| 隐藏开关 E2E（issue #3） | ✅ 设置页点「显示中 → 已隐藏」，composer 里净室 chip **立即消失**；`ui.json` 写入 `composerMode:false`，`GET /api/ui` 同步；点回「显示中」后 chip 立即回来 |
| 状态复原 | ✅ `bridge.json` enabled=false、`mode.json` clean、`ui.json` 两项 true —— 与验收前一致 |

## 像素采样

| 状态 | 圆点颜色 | 说明 |
|---|---|---|
| 桥关 / 净室（默认） | `(233,233,233)` | 灰点。按 `opacity .85` 与白底混合反推 token ≈ `#E5E5E5`（`border-l2`） |
| 桥开 | `(245,158,11)` | 琥珀，**全不透明** → 证明「热」状态 `opacity:1` 规则生效 |
| 深度模式 | `(245,158,11)` | 同上 |

## 限制

- 只看了**浅色主题**、单显示器 1366×768、DPI 100%；深色主题、窄窗口/手机宽度、悬停与禁用（请求进行中）态的观感未逐像素验证。
- 截图是本机环境的证据，不代表其它主题/缩放/语言下的最终观感；如后续调整配色，需重新按本表复验。
- 复原操作只还原了状态文件，未验证「重开页面后 localStorage 缓存」的第二次冷启动路径（本次开关是从设置页写 ui.json，缓存按设计随后对齐）。

## 截图

- `craft-v072-visual-acceptance.png`：三态 composer 裁切 + 设置页两态（本文件的配图）
- 原始截图：`craft-v072-baseline.png`、`craft-v072-bridge-on.png`、`craft-v072-mode-deep.png`、`craft-v072-settings-shown.png`、`craft-v072-settings-mode-hidden.png`、`craft-v072-settings-restored.png`
