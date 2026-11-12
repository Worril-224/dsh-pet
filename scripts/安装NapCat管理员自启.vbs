' Chinese-named convenience entry: forwards to install-napcat-autostart-admin.vbs in the same folder.
' Optional first argument: bot QQ number, e.g. wscript <this-file> 123456789
Option Explicit
Dim fso, target, extra, i
Set fso = CreateObject("Scripting.FileSystemObject")
target = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "install-napcat-autostart-admin.vbs")
If Not fso.FileExists(target) Then
  MsgBox "Missing install-napcat-autostart-admin.vbs next to this script.", 16, "DshPet"
  WScript.Quit 1
End If
extra = ""
For i = 0 To WScript.Arguments.Count - 1
  extra = extra & " """ & WScript.Arguments(i) & """"
Next
CreateObject("WScript.Shell").Run "wscript.exe """ & target & """" & extra, 1, False
