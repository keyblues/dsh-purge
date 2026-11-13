# master 历史与旧版 DSH 兼容核查

核查日期：2026-11-13。核查对象是本地 `master`、`main`、`origin/main`，以及当前尚未提交的 1.1.94 工作区。

本记录中的分支关系描述核查当时的状态。随后准备提交 1.1.94 时，将本地导入提交 `bb8eb52` 保存在 `codex/imported-main-backup-20261113`，并把新提交接到 `origin/main` 的 1.1.93 历史上；master 历史保持独立。

## 结论

`master` 确实包含针对多个旧版 DSH 的兼容工作。最明确的多版本适配节点是 **1.1.88 / d1eff01**：同时保留 **0.2.1-rc.2 与 0.2.1-rc.5**，而不是只适配 rc.2。

提交历史断开没有导致这些核心补丁代码从 1.1.93 丢失。对比 `master` 的 1.1.90 和 `main` 的 1.1.93 基线，以下文件的 Git blob 完全相同：

- `lib/core.js`
- `lib/index.js`
- `lib/identity.js`
- `lib/desktop.js`
- `lib/web.js`
- `lib/extract-asar.js`
- `cordis.patch.yml`

其中 `lib/core.js` 两边的 blob 均为 `db251d79c68ab40341f11946f4368d49b932f0fc`。这项对比针对已提交的 1.1.93 基线；工作区中的 1.1.94 在它之上新增了本次 0.2.2-rc.1 适配。

## 可以确认的历史适配

| DSH 版本 | 插件历史节点 | 证据及范围 | 当前 1.1.94 的结论 |
| --- | --- | --- | --- |
| 0.1.7-rc.1 | 1.1.16 | master 内继承的 changelog 记录常量改名、沙箱签名、设置兼容等调整 | 历史支持；本次未回归，不列入当前已验证范围 |
| 0.1.7-rc.2 | 1.1.20 | changelog 记录升级请求 pattern 跟进，并明确保留 rc.1（含 20260924.1）锚点 | 同上 |
| 0.2.0-rc.2 | 1.1.40；1.1.42 补旧入口 | changelog 记录 OAuth 身份处理、入口锚点兼容等工作 | 仍可见历史兼容分支；本次未回归，不宣称全部可用 |
| 0.2.1-rc.2 | 1.1.73 起的可追溯提交 | `679a3db` 基线；`6cb2ac3` 补 object schema；`ba12c91` 清理废弃的 toolFilter | 当前保留，已对相关官方 npm 文件回归 |
| 0.2.1-rc.3 / rc.4 | 1.1.84 / `af47342` | 加入 rc.3 的局部 pattern，新增 rc.4 相关 #89 / #90 等可选补丁；package.json 此时仍只声明 rc.2 | 有部分适配证据，不能据此认定完整支持 |
| 0.2.1-rc.2 + rc.5 | 1.1.88 / `d1eff01` | 明确双版本适配；#32 / #36 / #50 / #53 / #57 / #62 保留旧 pattern 并增加新版分支，新增 dshTargets 两版本列表 | 当前均保留，已对相关官方 npm 文件回归 |
| 0.2.2-rc.1 | 本地 1.1.94 工作区 | 本次新增实际文件入口和接口适配 | 当前主适配版本；桌面文件与隔离 Web 运行验证见适配记录 |

证据强度需要区分：master 可追溯的提交从 1.1.73 开始；1.1.16 / 1.1.20 / 1.1.40 等更早版本在当前仓库中只有继承的 changelog 记录，没有对应的原始 Git 提交可逐条核验。

1.1.88 的 changelog 还记载了当时 Web / Desktop 的补丁检查和 42 个目标文件的 apply/revert 检查。这属于历史发布记录，不能替代对当前机器、当前宿主的重新验证。

## main 为什么没有连续历史

当前仓库不是浅克隆；`git rev-parse --is-shallow-repository` 返回 `false`。

本地可见的提交关系分成三条互不相连的历史：

1. `master`：37 个提交，根提交 `679a3db`（1.1.73），末端 `4c3369a`（1.1.90 的仓库维护）。
2. `origin/main`：`934e966`（从已安装插件回收的 1.1.92 快照）→ `6e9f005`（1.1.93）。快照提交说明明确写了原仓库不可用、保留的 master 停在 1.1.90，因此没有原版 1.1.92 的上游历史。
3. 本地 `main`：单个根提交 `bb8eb52`。提交说明记录，当时 GitHub git 连接失败，使用 codeload 归档导入了对应 `6e9f005` 的 1.1.93 文件树，因此没有带入父提交。

GitHub 的 `master...main` compare 同样返回 `No common ancestor between master and main`，与本地根提交检查一致。

这解释了为什么 main 有较新的文件内容，却看不到 master 的逐次提交。当前核查没有切换分支、合并、重写历史或提交工作区改动。

## 当前应如何理解兼容范围

当前 1.1.94 明确声明并检查的版本为：

```json
["0.2.2-rc.1", "0.2.1-rc.5", "0.2.1-rc.2"]
```

更老的 pattern 仍有保留，但“以前发布过适配”“当前代码中仍有某些旧入口”“当前完整验证通过”是三个不同层次。0.1.7、0.2.0、rc.3 / rc.4 不应仅凭历史记录加入当前已验证列表。

继续使用 main 开发时，可以把 master 作为历史依据；是否恢复提交祖先关系是单独的 Git 历史整理工作，无需为了查旧兼容而把历史文件树覆盖到当前工作区。

## 主要来源

- [master 的版本声明](https://github.com/keyblues/dsh-purge/blob/master/package.json)
- [1.1.88 双版本适配提交](https://github.com/keyblues/dsh-purge/commit/d1eff01eb6ce647d6ea77bb5cbcc964d1e9dd2e7)
- [1.1.84 的 rc.3 / rc.4 局部适配](https://github.com/keyblues/dsh-purge/commit/af47342)
- [master 的历史发布记录](https://github.com/keyblues/dsh-purge/blob/master/release-notes.md)
- [1.1.92 快照的来源说明](https://github.com/keyblues/dsh-purge/commit/934e9662501e0f36831fcfad0e60a492c2a97513)

本地复核命令：

```text
git log master --oneline
git show d1eff01:package.json
git diff master main -- lib/core.js lib/index.js lib/identity.js lib/desktop.js lib/web.js lib/extract-asar.js cordis.patch.yml
git rev-list --max-parents=0 master main origin/main
git show --no-patch --format=fuller 934e966
git show --no-patch --format=fuller bb8eb52
```
