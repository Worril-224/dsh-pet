# NapCat 开机自启 / 后台守护 安装脚本（需要管理员权限）
#
# 适用前提：NapCat 需要管理员权限启动（普通权限可能只打开普通 QQ，不会注入 NapCat）。
# 本脚本创建“登录时以最高权限运行”的计划任务，开机后隐藏窗口启动守护，
# 守护再以管理员权限启动 NapCat（launcher.bat），之后不再弹 UAC。
#
# 路径推导：默认 <仓库目录>/NapCat.Shell；可用 -NapCatDir 或环境变量 DSH_PET_NAPCAT_DIR 覆盖。
# 机器人 QQ：用 -BotQQ 指定，例如 -BotQQ 123456789（123456789 只是示例值）；
#            不传时依次取 $env:DSH_PET_BOT_QQ → 示例值。启动时用 `-q <QQ>` 快速登录。
#
# 推荐用法：双击 scripts\install-napcat-autostart-admin.bat 123456789（弹 UAC，点“是”）
# 或者以管理员身份运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-napcat-autostart.ps1 -StartNow -BotQQ 123456789
#
# 卸载（删除计划任务需要管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-napcat-autostart.ps1 -Uninstall
#
# 停止守护（不卸载自启）：
#   创建文件 <NapCatDir>\STOP_AUTOSTART.flag

param(
  [switch]$Uninstall,
  [switch]$StartNow,
  [string]$BotQQ = $env:DSH_PET_BOT_QQ,
  [string]$NapCatDir = $env:DSH_PET_NAPCAT_DIR
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
if (-not $NapCatDir) {
  $NapCatDir = Join-Path (Split-Path -Parent $ScriptDir) 'NapCat.Shell'
}
$Root = [System.IO.Path]::GetFullPath($NapCatDir)
if (-not $BotQQ) {
  $BotQQ = '123456789'
}
$Vbs = Join-Path $ScriptDir 'napcat-autostart-hidden.vbs'
$Launcher = Join-Path $ScriptDir 'napcat-autostart.ps1'
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'NapCat 后台自启.lnk'
$TaskName = 'DshPet-NapCat-Autostart'
$StopFlag = Join-Path $Root 'STOP_AUTOSTART.flag'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Remove-StartupShortcut {
  if (Test-Path $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
    Write-Host "已删除用户级启动快捷方式：$ShortcutPath"
  }
}

function Remove-ScheduledTask {
  try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "已删除计划任务：$TaskName"
    }
  } catch {
    Write-Host "删除计划任务失败（需要管理员）：$($_.Exception.Message)"
  }
}

if ($Uninstall) {
  Remove-StartupShortcut
  Remove-ScheduledTask
  if (Test-Path $StopFlag) { Remove-Item -LiteralPath $StopFlag -Force }
  Write-Host '卸载完成。'
  exit 0
}

foreach ($file in @($Vbs, $Launcher, (Join-Path $Root 'NapCatWinBootMain.exe'))) {
  if (-not (Test-Path $file)) {
    Write-Error "缺少文件：$file"
    exit 1
  }
}

if (-not (Test-Admin)) {
  Write-Host ''
  Write-Host '需要管理员权限。' -ForegroundColor Red
  Write-Host 'NapCat 需要管理员模式启动（普通权限可能只打开普通 QQ，不会注入 NapCat）。'
  Write-Host "请双击运行：$(Join-Path $ScriptDir 'install-napcat-autostart-admin.bat')（在弹出的 UAC 窗口点“是”）"
  Write-Host ''
  exit 1
}

New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null
if (Test-Path $StopFlag) {
  Remove-Item -LiteralPath $StopFlag -Force
  Write-Host '已移除停止标记 STOP_AUTOSTART.flag。'
}

Remove-StartupShortcut

# 计划任务把机器人 QQ 作为参数传给隐藏启动器，避免把 QQ 号写死在 .vbs 里。
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $Vbs + '" "' + $BotQQ + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "已创建计划任务：$TaskName（登录时以最高权限运行，无 UAC）"

if ($StartNow) {
  Write-Host '正在以管理员权限启动后台守护（NapCat 会自动拉起，窗口最小化）…'
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Vbs + '" "' + $BotQQ + '"') -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 4
  Write-Host '提示：如果弹出 QQ 登录窗口，请用机器人 QQ 登录（-q 快速登录需要 NapCat 里已保存该号的登录记录）；登录后 6099/3001 会自动监听。'
}

if ($BotQQ -eq '123456789') {
  Write-Host ''
  Write-Host '注意：当前机器人 QQ 是示例值 123456789。要换成你自己的机器人 QQ，请重新运行并加 -BotQQ <QQ号>。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '相关路径：'
Write-Host "  NapCat 目录：$Root"
Write-Host "  守护日志：$(Join-Path $Root 'logs\autostart.log')"
Write-Host "  停止守护：创建文件 $StopFlag"
Write-Host "  卸载自启：以管理员运行本脚本并加 -Uninstall"
Write-Host ''
Write-Host '提醒：自启只保证 NapCat 进程后台运行；机器人 QQ 掉登录时仍需打开 QQ 窗口重新扫码（保存快速登录可自动登录）。'
