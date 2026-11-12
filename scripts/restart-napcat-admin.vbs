' Restart NapCat with quick login (-q). Requires UAC confirmation.
' Kills the stuck NapCat/QQ tree, waits 3s, then launches launcher.bat -q <QQ>.
' Paths are derived from this script's location; NapCat Shell is expected at
' <repo>\NapCat.Shell by default. Override it with DSH_PET_NAPCAT_DIR.
' Optional first argument: bot QQ number (default 123456789, a placeholder).
Option Explicit
Dim fso, ws, shell, scriptDir, napcatDir, launcher, botQQ, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
Set shell = CreateObject("Shell.Application")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
napcatDir = ws.ExpandEnvironmentStrings("%DSH_PET_NAPCAT_DIR%")
If Left(napcatDir, 1) = "%" Then
  napcatDir = ""
End If
If napcatDir = "" Then
  napcatDir = fso.BuildPath(fso.GetParentFolderName(scriptDir), "NapCat.Shell")
End If
botQQ = "123456789"
If WScript.Arguments.Count > 0 Then
  If Len(Trim(WScript.Arguments(0))) > 0 Then
    botQQ = Trim(WScript.Arguments(0))
  End If
End If
launcher = fso.BuildPath(napcatDir, "launcher.bat")
If Not fso.FileExists(launcher) Then
  MsgBox "NapCat launcher not found:" & vbCrLf & launcher & vbCrLf & vbCrLf & _
         "Put the NapCat Shell folder at <repo>\NapCat.Shell, or set DSH_PET_NAPCAT_DIR.", 16, "DshPet"
  WScript.Quit 1
End If
cmd = "/c taskkill /IM NapCatWinBootMain.exe /T /F >nul 2>&1 & timeout /t 3 /nobreak >nul & """ & launcher & """ -q " & botQQ
shell.ShellExecute "cmd.exe", cmd, napcatDir, "runas", 1
