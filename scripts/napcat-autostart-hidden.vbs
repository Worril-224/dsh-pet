' Launch the NapCat background watchdog (napcat-autostart.ps1) with a hidden window.
' Called by the logon scheduled task created by install-napcat-autostart.ps1.
' Optional first argument: bot QQ number, passed through as -BotQQ to the watchdog.
Option Explicit
Dim fso, shell, scriptDir, ps1, cmd, extra
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "napcat-autostart.ps1")
If Not fso.FileExists(ps1) Then
  WScript.Quit 1
End If
extra = ""
If WScript.Arguments.Count > 0 Then
  If Len(Trim(WScript.Arguments(0))) > 0 Then
    extra = " -BotQQ " & Trim(WScript.Arguments(0))
  End If
End If
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """" & extra
' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False
