#requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-purge 装进另一份 DSH（另一个宿主 / 另一台机器），默认全程离线。

.DESCRIPTION
  只做四件事，不点「应用」、不重启宿主、不碰 @deepseek-ai：
    1) 把本仓库复制到 <DSH_HOME>\plugins\dsh-purge（目录名固定）
    2) 在该 profile 的 package.json 里加 dependencies + dsh.profile.bundles
    3) 在 <profile>\node_modules 建 dsh-purge 目录联接（或 -UsePnpm 走 pnpm install）
    4) 跑插件自带 ensure-profile-bundle.mjs，补用户层 cordis.patch.yml 的本体 insert
  写盘前会把 package.json 备份成 package.json.bak-<时间戳>。

.PARAMETER Source
  dsh-purge 仓库根目录。默认取本脚本上一级（scripts 的父目录）。

.PARAMETER FromTarball
  npm 打包产物（dsh-purge-<版本>.tgz）。给了就解压到临时目录再用，不用准备整份仓库。

.PARAMETER DshHome
  目标 DSH_HOME。留空按 DSH_HOME 环境变量 → %USERPROFILE%\.dsh →
  %LOCALAPPDATA%\DeepSeek Harness\dsh-home → %APPDATA%\DeepSeek Harness\dsh-home 依次找。

.PARAMETER ProfileName
  web / desktop。留空时若只有一个 profile 装它就选那个；有多个则列出并要求指定。

.PARAMETER UsePnpm
  用 pnpm install 建链接，而不是目录联接。pnpm 连不上源时会失败，失败后可去掉此开关重跑。

.PARAMETER DryRun
  只打印将要做什么，不写盘。

.EXAMPLE
  # 本机另装一份桌面端
  pwsh -File scripts\install-other-dsh.ps1 -DshHome D:\dsh-home -ProfileName desktop

.EXAMPLE
  # 拷到别的机器上先解压仓库，再在仓库根执行
  powershell -ExecutionPolicy Bypass -File scripts\install-other-dsh.ps1 -ProfileName web
#>
[CmdletBinding()]
param(
  [string]$Source = "",
  [string]$FromTarball = "",
  [string]$DshHome = "",
  [string]$ProfileName = "",
  [switch]$UsePnpm,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($msg) { Write-Host "  $msg" }
function Write-Ok($msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [fail] $msg" -ForegroundColor Red; exit 1 }

function Read-Json($path) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return $text | ConvertFrom-Json
}

function Save-Json($obj, $path) {
  $json = ($obj | ConvertTo-Json -Depth 100) + "`n"
  [System.IO.File]::WriteAllText($path, $json, $Utf8NoBom)
}

function Set-Prop($obj, $name, $value) {
  if ($obj.PSObject.Properties.Name -contains $name) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

function Get-PropHolder($obj, $name) {
  if ($obj.PSObject.Properties.Name -contains $name -and $obj.$name) { return $obj.$name }
  $holder = [pscustomobject]@{}
  Set-Prop $obj $name $holder
  return $holder
}

Write-Host "dsh-purge → 别的 DSH 安装" -ForegroundColor Cyan

# ── 1. 源目录 ────────────────────────────────────────────────────────────────
if ($FromTarball) {
  if (-not (Test-Path $FromTarball)) { Fail "压缩包不存在：$FromTarball" }
  $FromTarball = (Resolve-Path $FromTarball).Path
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $tar) { Fail "系统没有 tar，先手动解压 $FromTarball，再用 -Source 指向解压出的目录" }
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-purge-stage-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Write-Step "解压 $(Split-Path -Leaf $FromTarball) → $stage"
  & tar -xzf $FromTarball -C $stage
  if ($LASTEXITCODE -ne 0) { Fail "解压失败（tar 退出码 $LASTEXITCODE）" }
  $global:LASTEXITCODE = 0
  # npm 打包产物里多一层 package/
  $inner = Join-Path $stage 'package'
  $Source = if (Test-Path (Join-Path $inner 'package.json')) { $inner } else { $stage }
}
if (-not $Source) { $Source = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path $Source)) { Fail "源目录不存在：$Source" }
$Source = (Resolve-Path $Source).Path
$srcPkgPath = Join-Path $Source 'package.json'
if (-not (Test-Path $srcPkgPath)) { Fail "源目录里没有 package.json：$Source" }
$srcPkg = Read-Json $srcPkgPath
if ($srcPkg.name -ne 'dsh-purge') { Fail "源目录不是 dsh-purge 仓库（name=$($srcPkg.name)）：$Source" }
if (-not (Test-Path (Join-Path $Source 'lib\index.js'))) { Fail "源目录缺 lib\index.js，可能只拷了几个文件" }
if (-not (Test-Path (Join-Path $Source 'cordis.patch.yml'))) { Fail "源目录缺 cordis.patch.yml，宿主不会加载插件" }
Write-Ok "源：$Source (v$($srcPkg.version))"

# ── 2. 目标 DSH_HOME ────────────────────────────────────────────────────────
$looked = @()
if (-not $DshHome) {
  if ($env:DSH_HOME) { $looked += $env:DSH_HOME }
  $looked += (Join-Path $env:USERPROFILE '.dsh')
  $looked += (Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\dsh-home')
  $looked += (Join-Path $env:APPDATA 'DeepSeek Harness\dsh-home')
  foreach ($cand in $looked) {
    if ($cand -and (Test-Path (Join-Path $cand 'profiles'))) { $DshHome = $cand; break }
  }
}
if (-not $DshHome -or -not (Test-Path $DshHome)) {
  Fail "没找到 DSH_HOME。查过：`n    $($looked -join "`n    ")`n  请用 -DshHome 明确指定（目录里要有 profiles）。"
}
$DshHome = (Resolve-Path $DshHome).Path
$profilesRoot = Join-Path $DshHome 'profiles'
if (-not (Test-Path $profilesRoot)) { Fail "$DshHome 下没有 profiles，不像是 DSH_HOME" }
Write-Ok "DSH_HOME：$DshHome"

# ── 3. 目标 profile ─────────────────────────────────────────────────────────
$profiles = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
if ($profiles.Count -eq 0) { Fail "$profilesRoot 下没有带 package.json 的 profile" }

if ($ProfileName) {
  $hit = $profiles | Where-Object { $_.Name -eq $ProfileName }
  if (-not $hit) {
    Fail "没有 profile「$ProfileName」。现有：$($profiles.Name -join ', ')`n  官方 web / 桌面分别用：-ProfileName web / -ProfileName desktop"
  }
  $profileDir = $hit.FullName
} elseif ($profiles.Count -eq 1) {
  $profileDir = $profiles[0].FullName
} else {
  Fail "有多个 profile，请用 -ProfileName 指定：$($profiles.Name -join ', ')"
}
$profilePkgPath = Join-Path $profileDir 'package.json'
$profilePkg = Read-Json $profilePkgPath
Write-Ok "profile：$profileDir（$($profilePkg.name)）"

# ── 4. 复制插件本体 ─────────────────────────────────────────────────────────
$pluginsRoot = Join-Path $DshHome 'plugins'
$dest = Join-Path $pluginsRoot 'dsh-purge'
Write-Step "插件目录：$dest"
if ($DryRun) { Write-Step "(dry-run) 跳过复制/写入" }
else {
  if (-not (Test-Path $pluginsRoot)) { New-Item -ItemType Directory -Force -Path $pluginsRoot | Out-Null }
  if (Test-Path $dest) {
    # 旧副本里可能有用户改过的提示词，不直接覆盖
    $bak = "$dest.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Rename-Item -Path $dest -NewName (Split-Path -Leaf $bak)
    Write-Warn2 "旧副本已改名备份 → $bak"
  }
  $robocopyArgs = @($Source, $dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
    '/XD', 'node_modules', '.git', '.github', '.scratch', 'dist')
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "复制失败（robocopy 退出码 $LASTEXITCODE）" }
  $global:LASTEXITCODE = 0
  Write-Ok "已复制：$((Get-ChildItem $dest -Recurse -File | Measure-Object).Count) 个文件"
}

# ── 5. 改 profile/package.json ──────────────────────────────────────────────
$depSpec = 'file:../../plugins/dsh-purge'
$profilePkg = Read-Json $profilePkgPath
$deps = Get-PropHolder $profilePkg 'dependencies'
$oldDep = if ($deps.PSObject.Properties.Name -contains 'dsh-purge') { $deps.'dsh-purge' } else { $null }
Set-Prop $deps 'dsh-purge' $depSpec
$dshBlock = Get-PropHolder $profilePkg 'dsh'
$profBlock = Get-PropHolder $dshBlock 'profile'
$bundles = @()
if ($profBlock.PSObject.Properties.Name -contains 'bundles' -and $profBlock.bundles) { $bundles = @($profBlock.bundles) }
if ($bundles -notcontains 'dsh-purge') { $bundles += 'dsh-purge' }
Set-Prop $profBlock 'bundles' $bundles

if ($DryRun) {
  Write-Step "(dry-run) 会在 $profilePkgPath 写入 dependencies.dsh-purge = $depSpec，bundles += dsh-purge"
} else {
  Copy-Item $profilePkgPath "$profilePkgPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
  Save-Json $profilePkg $profilePkgPath
  Write-Ok "已写 package.json：dsh-purge → $depSpec，bundles 共 $($bundles.Count) 项"
  if ($oldDep -and $oldDep -ne $depSpec) { Write-Step "原依赖写法 $oldDep 已换成 $depSpec" }
}

# ── 6. node_modules 链接 ───────────────────────────────────────────────────
$nm = Join-Path $profileDir 'node_modules'
$link = Join-Path $nm 'dsh-purge'
if (-not $DryRun) {
  if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Force -Path $nm | Out-Null }
  if (Test-Path $link) {
    $linkBak = "$link.old-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item -Path $link -Destination $linkBak -Force
    Write-Warn2 "旧 node_modules\dsh-purge 已挪到 $linkBak"
  }
  $linked = $false
  if ($UsePnpm) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpm) {
      Write-Step "pnpm install（--prefer-offline）…"
      Push-Location $profileDir
      try {
        & pnpm install --prefer-offline 2>&1 | ForEach-Object { Write-Step $_ }
        $code = $LASTEXITCODE
      } finally { Pop-Location }
      if ($code -eq 0 -and (Test-Path $link)) { $linked = $true; Write-Ok "pnpm 已建立链接" }
      else { Write-Warn2 "pnpm 没成功（退出码 $code），改用目录联接" }
    } else { Write-Warn2 "PATH 里没有 pnpm，改用目录联接" }
  }
  if (-not $linked) {
    if (Test-Path $link) { Remove-Item $link -Recurse -Force }
    New-Item -ItemType Junction -Path $link -Target $dest | Out-Null
    Write-Ok "已建目录联接：$link → $dest"
  }
}

# ── 7. 补本体 insert / allowBuilds ─────────────────────────────────────────
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warn2 "PATH 里没有 node，跳过后置步骤；装好 node 后在该 profile 目录执行：node `"$dest\scripts\ensure-profile-bundle.mjs`""
} elseif (-not $DryRun) {
  Push-Location $profileDir
  try { & node (Join-Path $dest 'scripts\ensure-profile-bundle.mjs') 2>&1 | ForEach-Object { Write-Step $_ } }
  finally { Pop-Location }
  $global:LASTEXITCODE = 0
}

# ── 8. 完成标志 ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "完成标志核查" -ForegroundColor Cyan
$checkPkg = Read-Json $profilePkgPath
$bOk = @($checkPkg.dsh.profile.bundles) -contains 'dsh-purge'
$dOk = $checkPkg.dependencies.PSObject.Properties.Name -contains 'dsh-purge'
$nOk = Test-Path (Join-Path (Join-Path $profileDir 'node_modules\dsh-purge') 'package.json')
$patchText = ''
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchFile) {
  $patchText = [System.IO.File]::ReadAllText($patchFile, [System.Text.Encoding]::UTF8)
}
$iOk = $patchText -match '(?m)^\s*-\s*id:\s*dsh-purge\s*$'
foreach ($pair in @(@('bundles 含 dsh-purge', $bOk), @('dependencies 含 dsh-purge', $dOk),
    @('node_modules\dsh-purge\package.json 在', $nOk), @('cordis.patch.yml 有 id: dsh-purge', $iOk))) {
  if ($pair[1]) { Write-Ok $pair[0] } else { Write-Warn2 $pair[0] }
}
if (-not $iOk) {
  Write-Step "insert 没写上时手动追加到 $patchFile ："
  Write-Step "- insert:"
  Write-Step "    - id: dsh-purge"
  Write-Step "      name: dsh-purge"
  Write-Step "      inject: [systemPrompt, tools]"
  Write-Step "      config:"
  Write-Step "        enabled: true"
  Write-Host ""
}
Write-Host ""
Write-Host "下一步（必须人工做，本脚本不代劳）" -ForegroundColor Cyan
Write-Host "  1. 完全退出这个宿主再打开（Web：停掉 dsh web；桌面：托盘也退出，再开 exe）"
Write-Host "  2. 会话标题旁出现 dsh-purge → 「清洗」→ 「应用」（成功会自动重启一次）"
Write-Host "  3. 聊天里 /purge status 能打出 DSH_HOME 和补丁列表 = 成功"
