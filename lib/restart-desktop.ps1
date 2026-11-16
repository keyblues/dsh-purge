param(
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$AsarPath,
  [Parameter(Mandatory = $true)][string]$ExePath
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP 'dsh-purge-desktop.log'
$stopped = $false
$relaunched = $false

function Write-SwapLog([string]$message) {
  try {
    Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [asar-swap] ' + $message)
  } catch {}
}

function Get-HarnessProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $ep = $_.ExecutablePath
    if (-not $ep) { return $false }
    $full = [System.IO.Path]::GetFullPath($ep)
    $full.Equals($ExePath, [System.StringComparison]::OrdinalIgnoreCase) -or
      $full.StartsWith($installRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-HarnessInstall {
  $processes = @(Get-HarnessProcesses)
  $ids = @{}
  foreach ($entry in $processes) { $ids[[int]$entry.ProcessId] = $true }
  # The Electron host also has no --type argument. Use the process tree to
  # stop the shell before its host, including when WMI returns the host first.
  $mains = @($processes | Where-Object {
    $_.ProcessId -ne $WaitPid -and -not $ids.ContainsKey([int]$_.ParentProcessId)
  })
  $ordered = @($mains) + @($processes | Where-Object { $_.ProcessId -notin $mains.ProcessId })
  foreach ($entry in $ordered) {
    $targetPid = [int]$entry.ProcessId
    $target = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if (-not $target -or $target.HasExited) { continue }
    Stop-Process -Id $targetPid -Force -ErrorAction Stop
    Wait-Process -Id $targetPid -Timeout 5 -ErrorAction SilentlyContinue
    $remaining = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($remaining -and -not $remaining.HasExited) {
      throw "Process $targetPid did not stop; archive was not changed"
    }
    Write-SwapLog ('stopped pid=' + $targetPid)
  }
}

function Start-Harness {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_BASE -ErrorAction SilentlyContinue
  if (-not $env:DSH_PROFILE) { $env:DSH_PROFILE = 'desktop' }
  Start-Process -FilePath $ExePath -WorkingDirectory $installRoot -ErrorAction Stop
  $script:relaunched = $true
  Write-SwapLog 'started desktop'
}

try {
  Write-SwapLog ('begin helperPid=' + $PID + ' hostPid=' + $WaitPid)
  $ExePath = [System.IO.Path]::GetFullPath($ExePath)
  $installRoot = [System.IO.Path]::GetDirectoryName($ExePath).TrimEnd('\')
  $AsarPath = [System.IO.Path]::GetFullPath($AsarPath)
  $expectedAsar = Join-Path $installRoot 'resources\app.asar'
  if ($installRoot -eq [System.IO.Path]::GetPathRoot($ExePath).TrimEnd('\') -or
      -not $AsarPath.Equals($expectedAsar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Archive does not belong to the selected desktop installation'
  }
  if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { throw 'Desktop executable is missing' }
  $appDir = Join-Path ([System.IO.Path]::GetDirectoryName($AsarPath)) 'app'
  $packageFile = Join-Path $appDir 'package.json'
  $package = Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $entry = if ($package.main) { [string]$package.main } else { 'index.js' }
  $entryPath = [System.IO.Path]::GetFullPath((Join-Path $appDir $entry))
  if (-not $entryPath.StartsWith($appDir + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw 'Unpacked desktop entry is missing; keeping the running application'
  }

  # Check process enumeration before changing anything. An unavailable WMI
  # service must leave the host running instead of triggering a timed exit.
  $null = Get-HarnessProcesses
  $stopped = $true
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Stop-HarnessInstall
    if (@(Get-HarnessProcesses).Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)
  if (@(Get-HarnessProcesses).Count -gt 0) { throw 'Desktop processes still hold the archive' }

  $unpacked = $AsarPath + '.unpacked'
  $marker = Join-Path $appDir 'dsh\node_modules\node-addon-require-builtin-win32-x64-msvc\prebuilt\win32-x64-msvc-napi-v9.node'
  if ((Test-Path -LiteralPath $unpacked) -and -not (Test-Path -LiteralPath $marker)) {
    & robocopy.exe $unpacked $appDir /E /XC /XN /XO /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('Native module overlay failed: ' + $LASTEXITCODE) }
  }

  $hadAsar = Test-Path -LiteralPath $AsarPath -PathType Leaf
  if ($hadAsar) {
    $bak = $AsarPath + '.bak'
    if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
      try {
        Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop
        break
      } catch {
        if ($attempt -eq 79) { throw }
        Start-Sleep -Milliseconds 300
      }
    }
    if (Test-Path -LiteralPath $AsarPath) { throw 'Archive is still sealed after rename' }
  }
  Remove-Item -LiteralPath ($AsarPath + '.rename-pending') -Force -ErrorAction SilentlyContinue
  Write-SwapLog $(if ($hadAsar) { 'moved asar -> bak (verified)' } else { 'asar already absent' })
  Start-Harness
} catch {
  Write-SwapLog ('failed: ' + $_.Exception.Message)
  if ($stopped -and -not $relaunched) {
    try { Start-Harness } catch { Write-SwapLog ('relaunch failed: ' + $_.Exception.Message) }
  }
  exit 1
}
