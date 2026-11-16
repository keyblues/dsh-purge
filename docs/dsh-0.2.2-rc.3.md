# dsh-purge 1.1.97：DSH 0.2.2-rc.3 适配记录

1.1.97 以 **DSH 0.2.2-rc.3** 为主目标，保留 **0.2.2-rc.1 / 0.2.1-rc.5 / 0.2.1-rc.2** 的兼容规则。CLI / Web 需要 Node.js **24.9.0 或更新版本**。

## 发布物来源

- [官方 rc.3 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3)，标签提交 `38a6a5c`。
- [官方 npm 元数据](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.2-rc.3)。相关 45 个 npm 包下载时均按 registry 的 `dist.integrity` 校验。
- 本机官方更新器下载的 `deepseek-harness-0.2.2-rc.3-win-x64.exe`，SHA-512 与其 `update-info.json` 一致。从安装包提取的桌面 `package.json` 为 `0.2.2-rc.3`，构建提交 `6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`。

标签和桌面构建提交不同，因此匹配与执行检查以各自实际发布文件为准。安装包检查先在仓库隔离目录进行。

## 失配与修复

| 补丁 | rc.3 的变化 | 1.1.97 的处理 |
| --- | --- | --- |
| #13 / #35 权限升级 | 普通 `Error` 改为带代码的 `SandboxEscalationError`；取消路径新增 `signal.throwIfAborted()` | 补充新结构的匹配，维持既有插件策略，同时保留任务已中止时的异常 |
| #18 重复工具提醒 | post-execute 监听器简化，原整段匹配不再命中 | 适配新监听器结构，配置验证仍执行 |
| #56 / #77 回退界面 | `client.js` 改为压缩构建，移除缩进并改用反引号字符串 | 在压缩后的 assembler 中加入可重复应用的回退过滤；回退标记到达时立即重建当前窗口 |
| #62 工具确认 | 拒绝结果改用 `approvalDenial(...)` 携带错误身份；类型侧运行文件仍用空格缩进 | 同时覆盖执行和类型副本；保留明确拒绝、取消标记及错误码，仅适配缺失确认服务、缺失调用 agent、通道不可用的分支 |
| #45 官方升级交接 | Windows 安装器通过替换整份应用目录升级 | 助手和安装器从临时目录运行，释放旧安装根目录作为工作目录时持有的句柄 |

新增 `lib/rewind-client.js` 为压缩前端提供过滤函数。行为测试覆盖保留此前轮次、只移除撤回轮次、保留系统消息、立即处理追加的回退标记、普通追加与去重。旧版前端的匹配规则继续保留。

## 验证

验证日期：2026-11-16。**39 项测试在本机 Windows 上通过**，包括 8 项 rc.3 行为测试和 2 项官方更新事务测试。

| 对象 | 检查文件数 | 漂移 / 待处理 | JS / JSON 语法错误 | 第二次 Apply 变化 |
| --- | ---: | ---: | ---: | ---: |
| rc.3 官方 Windows 桌面安装包 | 58 | 0 | 0 | 0 |
| rc.3 完整 npm Web 安装 | 57 | 0 | 0 | 0 |
| rc.1 相关 npm 包 | 56 | 0 | 0 | 0 |
| 0.2.1-rc.5 相关 npm 包 | 55 | 0 | 0 | 0 |
| 0.2.1-rc.2 相关 npm 包 | 55 | 0 | 0 | 0 |

缺少的预设、可选包和用户扩展按 `missing_file` 记录；不会计为已应用。表中的文件数和界面合并后的补丁组数不是同一种计数。

隔离的真实 rc.3 Web 宿主启动通过：首页 HTTP 200，`/dsh-purge/status` 返回正确版本；三个 `purge_*` 主工具和 14 个 HTTP 接口均注册成功。64 个演练工具在实际 Cordis 4.1.0 上注册成功。

本机官方 Windows 桌面已更新并重启，实际从 `resources/app` 加载 rc.3 与插件 1.1.97。补齐两条前端回退补丁后，再次重启成功；状态接口和实际插件面板均为 **68/70 已应用、跳过 2、漂移 0、待应用 0**，其中代码补丁 **42/42**。跳过项是 #71 梁神预设身份句清理和 #80 极简预设旧工具表还原，属于当前组件或内容条件不满足。诊断目录没有新增崩溃报告。

本次桌面验证包含插件面板渲染；Web 验证覆盖宿主启动与 HTTP 接口，未做 Web 页面渲染验证。未验证真实模型 API 调用，以及 macOS / Linux 的实机升级和重启。

## 本机官方更新故障

本机最初下载了 rc.3 安装包，但实际仍运行 rc.1。官方 `installer-logs/directory-failure-*.log` 记录 `MoveFileExW` 对安装根目录报 Windows 错误 32，插件旧交接助手返回 `installer 2` 后恢复了旧版本。

修复工作目录后，用原官方安装包重试成功：安装器返回 0，EXE 和归档均替换，应用重新启动。旧 rc.1 归档另存于本机隔离备份中。

官方桌面点「应用」仍沿用插件既有机制：解包官方归档，在 `resources/app` 内打补丁，重启时将原归档保留为 `app.asar.bak`。本版修改的是兼容规则和更新交接；安装步骤及目录行为见 [安装说明](install-other-dsh.md)。

## 检查与安装

```powershell
npm test
npm pack --pack-destination dist

# 在目标安装上只读检查；不会写入补丁或重启
npm run check:compat -- --base "C:\path\to\node_modules\@deepseek-ai" --surface web

# 将构建包安装到本机桌面 profile
powershell -ExecutionPolicy Bypass -File .\scripts\install-other-dsh.ps1 `
  -FromTarball .\dist\dsh-purge-1.1.97.tgz -ProfileName desktop
```

Web 端在其 profile 安装同一构建包；桌面和 Web 分开应用。升级后保留用户已有的自定义提示词与配置。
