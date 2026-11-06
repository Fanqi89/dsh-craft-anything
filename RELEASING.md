# 发布规范（本仓库长期有效）

本仓库的插件版本必须满足三条：**版本号唯一、标签不可移动、旧版本永久可装**。

## 版本号

- 唯一来源：`package.json` 的 `version`，必须与 `dsh.plugin.json` 的 `version` 完全一致（发布脚本会校验，不一致直接中止）。
- 语义化版本 `MAJOR.MINOR.PATCH`：
  - `PATCH`：修 bug、改文档、不动插件行为；
  - `MINOR`：新增工具 / 新槽位 / 行为变化（0.x 阶段允许不兼容，在 Release 说明里写清楚）；
  - `MAJOR`：1.0 之后的破坏性变更。
- 兼容下限写在两处 `engines.dsh`（当前 `>=0.2.0-rc.2`），提高下限属于 MINOR 及以上变更，必须写进 Release 说明。
- 版本号一旦发布**不复用、不回退、不改写**；发现问题发新 PATCH 版本。

## 标签与 GitHub Release

- 每次发布一个**附注标签** `vX.Y.Z` 指向发布提交，并建对应 GitHub Release。
- 标签**只增不移、不删、不覆盖**；Release 也不删（历史版本要能继续安装）。
- 因此多个版本在仓库里天然共存：
  - 装最新：`dsh plugin --profile desktop add github:Fanqi89/dsh-craft-anything`
  - 装指定版本：`dsh plugin --profile desktop add github:Fanqi89/dsh-craft-anything#v0.1.0`
- Release 正文取 `CHANGELOG.md` 中该版本的段落；标题 `vX.Y.Z — <一句话>`。

## 发布步骤（一条命令）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1
```

脚本按顺序执行，任一步失败即中止、不对外宣布：

1. 校验 `package.json` / `dsh.plugin.json` 的版本一致，且 `engines.dsh` 存在；
2. 校验 git 工作树干净、`main` 与 `origin/main` 同步；
3. `node --check` 校验 `host/index.js`、`client.js`，JSON 解析校验清单文件；
4. 目标标签不存在（存在则报错：标签不可移动）；
5. 创建附注标签 `vX.Y.Z` 并推送 `main` + 标签；
6. 用 GitHub API 建 Release（正文取 CHANGELOG 对应段落，幂等：已存在则只更新正文）；
7. 回读校验：远端标签指向本地提交、Release 存在且可访问，打印安装命令。

可选参数：`-NotesFile <文件>` 指定 Release 正文；`-SkipPush` 只做本地校验与打标签；`-Token <token>` 指定 token（默认从 `git credential fill` 取）。

## 发布前检查清单

- [ ] `CHANGELOG.md` 已加该版本段落（含安装/行为/限制变化）
- [ ] README 中 `engines.dsh`、安装命令与实际一致
- [ ] 插件在本机真机启用并跑过核心路径（`craft_status`、模式切换、页面）
- [ ] 版本号 `package.json` == `dsh.plugin.json`
- [ ] 旧标签一个都没动（`git ls-remote --tags origin` 里旧标签仍在）
