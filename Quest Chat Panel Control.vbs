Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
electron = root & "\node_modules\electron\dist\electron.exe"
main = root & "\scripts\control-main.js"
shell.Run """" & electron & """ """ & main & """", 0, False
