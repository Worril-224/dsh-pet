' Launch NapCat as Administrator (UAC prompt).
' Paths are derived from this script's location; NapCat Shell is expected at
' <repo>\NapCat.Shell by default. Override it with the DSH_PET_NAPCAT_DIR
' environment variable or pass the bot QQ number as the first argument.
' -q <QQ> enables quick login when a saved login record exists.
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
cmd = "/c """ & launcher & """ -q " & botQQ
shell.ShellExecute "cmd.exe", cmd, napcatDir, "runas", 1
