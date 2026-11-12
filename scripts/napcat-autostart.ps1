# NapCat 后台守护（Windows PowerShell，管理员模式）
# 设计目标：宁可“卡住等待”，也不要反复杀进程/重新登录。
#   - 只在 NapCat 进程完全不存在时启动一次；
#   - 进程存在但端口没起来：只记录日志，不自动 kill、不自动重登；
#   - 24 小时内最多自动启动 1 次；失败只等待，不再自动重复登录。
# 这样避免 QQ 因短时间反复登录被判定为机器人/踢下线。
#
# 路径推导：默认 <仓库目录>/NapCat.Shell；可用 -NapCatDir 或环境变量 DSH_PET_NAPCAT_DIR 覆盖。
# 日志：<NapCatDir>\logs\autostart.log
# 停止：创建文件 <NapCatDir>\STOP_AUTOSTART.flag
# 手动启动：双击 scripts\start-napcat-admin.bat（或传 -BotQQ 指定机器人 QQ）
#
# 参数：
#   -BotQQ <QQ号>     机器人 QQ 号（默认取 $env:DSH_PET_BOT_QQ，未设置时用示例值 123456789）。
#                     启动时以 `launcher.bat -q <QQ>` 快速登录（依赖 NapCat 里保存的登录记录）。
#   -NapCatDir <目录> NapCat Shell 目录（默认 <仓库目录>/NapCat.Shell 或 $env:DSH_PET_NAPCAT_DIR）。
#   -Once             只巡检一轮就退出（便于测试）。

param(
  [switch]$Once,
  [string]$BotQQ = $env:DSH_PET_BOT_QQ,
  [string]$NapCatDir = $env:DSH_PET_NAPCAT_DIR
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $NapCatDir) {
  $NapCatDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'NapCat.Shell'
}
$Root = [System.IO.Path]::GetFullPath($NapCatDir)
if (-not $BotQQ) {
  $BotQQ = '123456789'
}
$ScriptDir = $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$LogFile = Join-Path $LogDir 'autostart.log'
$StopFlag = Join-Path $Root 'STOP_AUTOSTART.flag'
$StateFile = Join-Path $Root 'autostart-state.json'
$MutexName = 'Local\DshPetNapCatAutostart'
$StuckWarnMinutes = 30
$StuckRecoverMinutes = 15
$StartCooldownMinutes = 240
$MaxStartsPerDay = 1
$MaxRecoveriesPerDay = 1
$RecoveryCooldownMinutes = 720
$RecoveryCheckSeconds = 180

function Write-Log([string]$Message) {
  try {
    if (-not (Test-Path $LogDir)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

function Test-Admin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch {
    return $false
  }
}

function Test-NapCatPorts {
  try {
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 6099, 3001 }
    return [bool]($listeners | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Test-WebUiPort {
  try {
    return [bool](Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 6099 } | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Test-NapCatProcess {
  return [bool](Get-Process -Name 'NapCatWinBootMain' -ErrorAction SilentlyContinue)
}

function Read-State {
  $today = Get-Date -Format 'yyyy-MM-dd'
  try {
    if (Test-Path $StateFile) {
      $state = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($state) {
        $sameStartDay = $state.day -eq $today
        $sameRecoveryDay = $state.recoveryDay -eq $today
        return [pscustomobject]@{
          day = $today
          starts = if ($sameStartDay -and $null -ne $state.starts) { [int]$state.starts } else { 0 }
          lastAttempt = if ($sameStartDay -and $null -ne $state.lastAttempt) { [string]$state.lastAttempt } else { '' }
          recoveryDay = $today
          recoveries = if ($sameRecoveryDay -and $null -ne $state.recoveries) { [int]$state.recoveries } else { 0 }
          lastRecoveryAt = if ($sameRecoveryDay -and $null -ne $state.lastRecoveryAt) { [string]$state.lastRecoveryAt } else { '' }
        }
      }
    }
  } catch { }
  return [pscustomobject]@{ day = $today; starts = 0; lastAttempt = ''; recoveryDay = $today; recoveries = 0; lastRecoveryAt = '' }
}

function Write-State($state) {
  try {
    $state | ConvertTo-Json -Compress | Set-Content -Path $StateFile -Encoding UTF8
  } catch { }
}

function Can-AutoStart($state) {
  if ($state.starts -ge $MaxStartsPerDay) {
    Write-Log ('24 小时内已自动启动 ' + $state.starts + ' 次，达到上限；不再自动登录，请手动检查/登录。')
    return $false
  }
  if ($state.lastAttempt) {
    try {
      $last = [datetime]::Parse($state.lastAttempt)
      if (((Get-Date) - $last).TotalMinutes -lt $StartCooldownMinutes) {
        Write-Log ('距上次自动启动不足 ' + $StartCooldownMinutes + ' 分钟，继续等待，不重复登录。')
        return $false
      }
    } catch { }
  }
  return $true
}

function Can-Recover($state) {
  $today = Get-Date -Format 'yyyy-MM-dd'
  if ($state.recoveryDay -ne $today) {
    $state.recoveryDay = $today
    $state.recoveries = 0
    $state.lastRecoveryAt = ''
  }
  if ($state.recoveries -ge $MaxRecoveriesPerDay) {
    Write-Log ('今日已自动恢复 ' + $state.recoveries + ' 次，达到上限；不再自动重启/登录，请手动扫码。')
    return $false
  }
  if ($state.lastRecoveryAt) {
    try {
      $last = [datetime]::Parse($state.lastRecoveryAt)
      if (((Get-Date) - $last).TotalMinutes -lt $RecoveryCooldownMinutes) {
        Write-Log ('距上次自动恢复不足 ' + $RecoveryCooldownMinutes + ' 分钟，继续等待。')
        return $false
      }
    } catch { }
  }
  return $true
}

function Invoke-SafeRecovery($state) {
  if (-not (Can-Recover($state))) { return $false }
  Write-Log ('检测到 NapCat 卡死（进程存在但 6099/3001 均未监听）超过 ' + $StuckRecoverMinutes + ' 分钟：执行一次受控恢复（-q 快速登录）。')
  try {
    Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/IM', 'NapCatWinBootMain.exe', '/T', '/F') -Wait -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 4
  } catch {
    Write-Log ('受控恢复：结束旧进程失败：' + $_.Exception.Message)
  }
  $started = Start-NapCat
  $state.day = Get-Date -Format 'yyyy-MM-dd'
  $state.recoveryDay = Get-Date -Format 'yyyy-MM-dd'
  $state.recoveries = [int]$state.recoveries + 1
  $state.lastRecoveryAt = (Get-Date).ToString('o')
  Write-State $state
  if (-not $started) {
    Write-Log '受控恢复：启动命令失败，请手动扫码登录；今日不再自动重试。'
    return $false
  }
  $deadline = (Get-Date).AddSeconds($RecoveryCheckSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Test-NapCatPorts) {
      Write-Log '受控恢复成功：NapCat 已重新监听端口。'
      return $true
    }
  }
  Write-Log '受控恢复失败：仍未监听端口，已锁定，今日不再自动重启；请手动扫码。'
  return $false
}

function Start-NapCat {
  if (-not (Test-Admin)) {
    Write-Log '当前非管理员权限，拒绝启动 NapCat。请用管理员方式启动。'
    return $false
  }
  if (-not (Test-Path (Join-Path $Root 'NapCatWinBootMain.exe'))) {
    Write-Log ('NapCat 目录不存在或缺少启动器：' + $Root)
    return $false
  }
  Write-Log ('启动 NapCat（launcher.bat -q ' + $BotQQ + '，管理员，最小化窗口）')
  try {
    $launcher = Join-Path $Root 'launcher.bat'
    $cmdLine = '/c "' + $launcher + '" -q ' + $BotQQ
    Start-Process -FilePath 'cmd.exe' -ArgumentList @($cmdLine) -WorkingDirectory $Root -WindowStyle Minimized | Out-Null
    return $true
  } catch {
    Write-Log ('启动失败：' + $_.Exception.Message)
    return $false
  }
}

# ---------- 单实例 ----------
$mutex = $null
try {
  $mutex = New-Object System.Threading.Mutex($false, $MutexName)
  if (-not $mutex.WaitOne(0)) {
    Write-Log '已有守护进程在运行，退出。'
    exit 0
  }
} catch { }

$admin = Test-Admin
Write-Log ('==== NapCat 后台守护启动（admin=' + $admin + '，防重复登录模式）====')
if (-not $admin) {
  Write-Log ('非管理员模式：只监控，不会启动 NapCat。请改用 ' + (Join-Path $ScriptDir 'install-napcat-autostart-admin.bat'))
}

$lastSpawn = [datetime]::MinValue
$loginWaitSince = $null
$warnedStuck = $false
$state = Read-State

while ($true) {
  if (Test-Path $StopFlag) {
    Write-Log '检测到 STOP_AUTOSTART.flag，守护退出。'
    break
  }

  if (Test-NapCatPorts) {
    if (-not $loginWaitSince -and -not $warnedStuck) {
      Write-Log 'NapCat 已在运行（6099/3001 已监听）。'
    }
    $loginWaitSince = $null
    $warnedStuck = $false
  } elseif (Test-NapCatProcess) {
    if ($null -eq $loginWaitSince) {
      $loginWaitSince = Get-Date
      $warnedStuck = $false
      Write-Log 'NapCat 进程已存在但端口尚未监听（可能在等待 QQ 登录/注入），先等待，不立即重启。'
    } elseif (-not (Test-WebUiPort) -and ((Get-Date) - $loginWaitSince).TotalMinutes -ge $StuckRecoverMinutes) {
      if (Can-Recover($state)) {
        Invoke-SafeRecovery $state | Out-Null
        $lastSpawn = Get-Date
        $loginWaitSince = Get-Date
        $warnedStuck = $false
      } else {
        $loginWaitSince = Get-Date
        $warnedStuck = $true
      }
    } elseif (-not $warnedStuck -and ((Get-Date) - $loginWaitSince).TotalMinutes -ge $StuckWarnMinutes) {
      $warnedStuck = $true
      Write-Log 'NapCat 进程已存在但端口仍未监听超过 ' + $StuckWarnMinutes + ' 分钟：请手动查看 QQ/NapCat 登录窗口；今日自动恢复已用完。'
    } elseif (((Get-Date) - $loginWaitSince).TotalMinutes -ge $StuckWarnMinutes) {
      # 只在每个 30 分钟窗口提醒一次，不重复 kill/login
      $loginWaitSince = Get-Date
      $warnedStuck = $false
    }
  } else {
    $loginWaitSince = $null
    if (-not $admin) {
      Write-Log ('非管理员：跳过自动启动。请双击 ' + (Join-Path $ScriptDir 'install-napcat-autostart-admin.bat') + ' 安装管理员自启。')
    } elseif (Can-AutoStart($state) -and ((Get-Date) - $lastSpawn).TotalMinutes -ge 5) {
      if (Start-NapCat) {
        $lastSpawn = Get-Date
        $state.starts = [int]$state.starts + 1
        $state.lastAttempt = (Get-Date).ToString('o')
        Write-State $state
      }
      Start-Sleep -Seconds 20
      if (Test-NapCatPorts) {
        Write-Log 'NapCat 已重新启动并监听端口。'
      }
    }
  }

  if ($Once) { break }
  Start-Sleep -Seconds 20
}

try {
  if ($mutex) { $mutex.ReleaseMutex() }
} catch { }
Write-Log '==== NapCat 后台守护退出 ===='
