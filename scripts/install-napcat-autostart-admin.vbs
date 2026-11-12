' One-click installer for the NapCat background autostart (elevates via UAC).
' Runs install-napcat-autostart.ps1 -StartNow from the same directory.
' Optional first argument: bot QQ number, e.g.
'   wscript install-napcat-autostart-admin.vbs 123456789
Option Explicit
Dim fso, shell, scriptDir, ps1, extra
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Shell.Application")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(scriptDir, "install-napcat-autostart.ps1")
If Not fso.FileExists(ps1) Then
  MsgBox "Missing install-napcat-autostart.ps1 next to this script.", 16, "DshPet"
  WScript.Quit 1
End If
extra = " -StartNow"
If WScript.Arguments.Count > 0 Then
  If Len(Trim(WScript.Arguments(0))) > 0 Then
    extra = extra & " -BotQQ " & Trim(WScript.Arguments(0))
  End If
End If
shell.ShellExecute "powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """" & extra, scriptDir, "runas", 1
