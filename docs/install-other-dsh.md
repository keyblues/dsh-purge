# 在另一份 DSH 上安装 dsh-purge

目标只有一个：把插件装进**目标那份宿主正在用的 profile**，让它出现在会话标题旁。
装插件和应用补丁是两步：本页只做第一步，第二步必须在目标宿主里点「清洗 → 应用」。

> **仓库地址**：`HunYiSage/dsh-purge` 已下架（2026-11-13 实测仓库页与 codeload 都是 404）。
> 现役仓库是 **`keyblues/dsh-purge`，默认分支 `main`，当前版本 1.1.94**。
> 网上旧教程、仓库 README 里的团队说明/署名段落仍写着 HunYiSage，按地址算一律作废，只认
> `codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main`。本仓库 `package.json`
> 的 `dsh.install` 与三份 README 的安装命令都已是 keyblues/main。

- 官方 `dsh web` 和官方桌面 EXE **分开装、分开应用**，补丁各写各的 `@deepseek-ai`。
- 1.1.94 适配 DSH 0.2.2-rc.1，保留 0.2.1-rc.5 / rc.2；详细验证范围见 [适配记录](dsh-0.2.2-rc.1.md)。CLI / Web 需要 Node.js 24.9.0 或更新版本，官方桌面端使用自带运行时。

---

## 0. 先摸清目标那份 DSH

| 要确认 | 怎么确认 |
|---|---|
| 宿主版本 | `dsh --version`；桌面端看 exe 属性。对照下面版本矩阵 |
| DSH_HOME | `$env:DSH_HOME`，否则 `%USERPROFILE%\.dsh`，便携包在安装根旁边，兜底 `%LOCALAPPDATA%\DeepSeek Harness\dsh-home` |
| profile 名 | `<DSH_HOME>\profiles\<web|desktop>\package.json` 里 `name` 是 `dsh-profile-web` / `dsh-profile-desktop` |
| 已装了什么 | 同目录 `dsh.profile.bundles` 列出所有已入队 bundle |

```powershell
$cands = @()
if ($env:DSH_HOME) { $cands += $env:DSH_HOME }
$cands += "$env:USERPROFILE\.dsh"
$cands += "$env:LOCALAPPDATA\DeepSeek Harness\dsh-home", "$env:APPDATA\DeepSeek Harness\dsh-home"
$cands | Select-Object -Unique | Where-Object { $_ -and (Test-Path (Join-Path $_ 'profiles')) }
Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | ForEach-Object {
  "$($_.Name) -> " + ((Get-Content (Join-Path $_.FullName 'package.json') -Raw | ConvertFrom-Json).name)
}
```

**版本矩阵**

| 目标宿主 | 用哪个版本 |
|---|---|
| 0.2.2-rc.1 | 1.1.94（当前 main） |
| 0.2.1-rc.2 / 0.2.1-rc.5 | 1.1.94 保留兼容，已检查相关 npm 文件 |
| 0.2.0-rc.2 | 历史版本从 1.1.40 开始支持；未纳入本次回归 |
| 0.1.7（含 rc.1/rc.2） | ≤ 1.1.39，去 Releases 选标签 |
| 0.2.1-rc.3 / rc.4、其他未列出的版本 | 不视为当前已完整验证，先运行只读兼容检查 |

## 1. 目标机器能上网：一条命令

```sh
# 官方 dsh web
dsh plugin --profile web add https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main

# 官方桌面 EXE
dsh plugin --profile desktop add https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main
```

0.2.2 的普通 npm CLI 不允许管理 Electron 专用的 `desktop` profile。桌面安装附带的管理入口可使用上面的 desktop 命令；遇到 reserved profile 提示时，使用第 3 节的离线安装脚本。

- 只用 `codeload.github.com` 归档写法。`github.com/.../archive/...` 是 302，pnpm 会 `fetch failed`；
  `git clone https://github.com/keyblues/dsh-purge.git` 走的是 git 智能协议（github.com:443），
  这条网络路径随时可能被重置，能用归档就别用 clone。
- 不要走插件市场/设置里的「插件市场」：会报 `already queued: dsh-purge`。
- npm 上没有这个包名，`pnpm add dsh-purge` 拉不到。

然后：**完全退出再打开**那个宿主（Web：停掉 `dsh web` 再开；桌面：托盘也退出，再开 exe）→ 会话标题旁点 **dsh-purge** → 「清洗」→ 「应用」→ 聊天里 `/purge status`。

## 2. 目标机器没有 `dsh`，只有 pnpm

进目标 profile，**不要在仓库根执行**：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"   # web 换 profiles\web
pnpm add --allow-build=dsh-purge https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main
```

pnpm 11/12 默认拦安装脚本（`ERR_PNPM_IGNORED_BUILDS`），被拦就补齐：

```powershell
pnpm approve-builds dsh-purge@https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main
node node_modules\dsh-purge\scripts\ensure-profile-bundle.mjs
```

`postinstall` 负责两笔：`dsh.profile.bundles` 末尾追加 `dsh-purge`、用户层 `cordis.patch.yml` 追加本体 `insert`。少任何一笔，宿主都不加载插件、界面也没有按钮。

## 3. 目标机器离线 / 内网：拷一个文件过去

在仓库根运行 `npm pack --pack-destination dist` 可生成 `dist/dsh-purge-1.1.94.tgz`，含 `cordis.patch.yml`、`lib/` 与 `postinstall`。把它拷到目标机器，按目标宿主选择安装方式：

```powershell
# a) 有 npm dsh：Web profile 可直接使用本地包
dsh plugin --profile web add .\dsh-purge-1.1.94.tgz

# b) 只有 pnpm：进 profile 再装
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add --allow-build=dsh-purge .\dsh-purge-1.1.94.tgz
node node_modules\dsh-purge\scripts\ensure-profile-bundle.mjs

# c) 都不放心，用仓库自带脚本整目录铺开（最稳，不依赖 pnpm）
powershell -ExecutionPolicy Bypass -File .\install-other-dsh.ps1 -FromTarball .\dsh-purge-1.1.94.tgz -ProfileName desktop
```

脚本 `scripts/install-other-dsh.ps1` 做四件事（全是加法，写前备份 `package.json`）：

1. 整目录铺到 `<DSH_HOME>\plugins\dsh-purge`（旧副本改名 `.bak-时间戳`，不覆盖你改过的提示词）
2. `<profile>\package.json`：`dependencies.dsh-purge = "file:../../plugins/dsh-purge"`，`dsh.profile.bundles` 末尾追加 `dsh-purge`
3. `<profile>\node_modules\dsh-purge` 建**目录联接**指向插件目录（`-UsePnpm` 改走 `pnpm install --prefer-offline`，失败自动回落联接）
4. 在该 profile 目录跑 `scripts/ensure-profile-bundle.mjs`：补本体 `insert` 和 `pnpm-workspace.yaml` 的 `allowBuilds`

参数：`-FromTarball <tgz>` 或 `-Source <仓库目录>`（默认本脚本上级目录）、`-DshHome`、`-ProfileName web|desktop`、`-DryRun`。

> 目录联接不是符号链接，Windows 上不需要管理员权限；Node 解析 `node_modules` 时照常命中。

没有 tgz 也没有仓库时，先在一台能上网的机器上取归档：

```powershell
Invoke-WebRequest 'https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main' -OutFile dsh-purge-main.tar.gz
```

## 4. 全手动（连脚本都不让跑）

1. 插件放到 `<DSH_HOME>\plugins\dsh-purge`（目录名必须是 `dsh-purge`，其 `package.json` 的 `name` 也必须是 `dsh-purge`）。
2. 备份并按需改 `<profile>\package.json`：`dependencies` 加 `"dsh-purge": "file:../../plugins/dsh-purge"`，`dsh.profile.bundles` 末尾加 `"dsh-purge"`。原有依赖、`patchReload`、版本号一个都不要动。
3. `<profile>\cordis.patch.yml` 追加本体行（**已有 `id: dsh-purge` 就不要再加**）：

```yaml
- insert:
    - id: dsh-purge
      name: dsh-purge
      inject: [systemPrompt, tools]
      config:
        enabled: true
        stripMnemon: true
        capabilityProtocol: true
        hooksDenyBypass: true
```

  文件内容只有一个 `[]` 时，把 `[]` **整行换掉**，不要往后面追加（会变成第二个 YAML 文档，宿主启动解析失败）。
4. 链接：`New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-purge" -Target "<DSH_HOME>\plugins\dsh-purge"`。

## 5. 装完之后的验证清单

| 检查 | 期望 |
|---|---|
| `dsh --dump-config`（桌面加 `--profile desktop`） | 有本体行 `id: dsh-purge`，不是 `dsh-purge-redteam` |
| `<profile>\package.json` | `bundles` 里恰好一个 `dsh-purge` |
| 重启后界面 | 会话标题旁出现 **dsh-purge** |
| 点「清洗 → 应用」 | 补丁逐个 `✓`；成功会自动重启一次 |
| 聊天 `/purge status` | 打出 `DSH_HOME`、插件根、补丁列表，路径指向目标那份 |

## 6. 常见坑

- **按钮不出现**：先看 `dump-config` 有没有 insert；缺就重跑 `ensure-profile-bundle.mjs`，再完全退出重开。开头几条 `entry "redteam-store" not found` 是旧红队包不在，忽略。
- **市场说 already queued**：先 `dsh plugin --profile desktop remove dsh-purge`，再用第 1 节命令装。
- **桌面端 `resources\app.asar` 还在**：官方壳读 asar，补丁写进解开的 `resources\app` 也读不到。此时点「应用」会走解包 + 挪走 asar + 重启（`lib/core.js` 那条路），别自己手动删。
- **补丁成片 `drifted`**：先确认已安装的插件版本；1.1.93 在 0.2.2-rc.1 上存在失配，应更新到 1.1.94。其他未列出的宿主版本先按 [适配记录](dsh-0.2.2-rc.1.md) 运行只读检查。
- **两个宿主都装**：`web` 和 `desktop` 各写各的 `@deepseek-ai`，分别在各自界面点「应用」，不要在一个里面点另一个的。
- **卸载**：`dsh-purge --uninstall`（先还原再删），或界面里卸载。

## 7. 交给目标机器上的助手执行

> 在这份 DSH 上安装插件 `dsh-purge`，只装当前正在用的那个 profile。
> 有 `dsh` 就跑
> `dsh plugin --profile <web|desktop> add https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main`；
> 没有 `dsh` 只有 pnpm 就进 `$DSH_HOME/profiles/<web|desktop>` 跑
> `pnpm add --allow-build=dsh-purge https://codeload.github.com/keyblues/dsh-purge/tar.gz/refs/heads/main`，
> 再跑 `node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs`。
> 离线机器用手里的 `dsh-purge-1.1.94.tgz`：Web 端可运行 `dsh plugin --profile web add .\dsh-purge-1.1.94.tgz`，或直接跑
> `install-other-dsh.ps1 -FromTarball .\dsh-purge-1.1.94.tgz -ProfileName <web|desktop>`。
> 不要走插件市场，不要 `pnpm add dsh-purge`，不要用已经 404 的 HunYiSage 地址，不要改其它文件，不要点应用，不要重启。
> 完成后提醒我：完全退出重开宿主 → 点会话标题旁 dsh-purge →「清洗」→「应用」→ `/purge status`。
