' Hidden launcher for collector.ps1 (avoids console window flash at logon).
' Self-locates collector.ps1 next to this script via WScript.ScriptFullName,
' instead of taking it as a command-line argument. This matters because a
' Startup-folder shortcut's Arguments string is stored using the legacy
' non-Unicode(ANSI) codepage inside the .lnk file, which corrupts non-ASCII
' (e.g. Japanese) path characters into "?" on some systems. TargetPath does
' not have this problem, so the shortcut is built with an empty Arguments
' string and this script resolves its own folder instead.
' Keep this file ASCII-only (VBScript is not UTF-8 aware).
Option Explicit
Dim fso, scriptDir, scriptPath, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(scriptDir, "collector.ps1")
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """", 0, False
