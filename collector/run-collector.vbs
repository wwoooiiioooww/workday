' Hidden launcher for collector.ps1 (avoids console window flash at logon).
' Usage: wscript.exe run-collector.vbs <full path to collector.ps1>
' Keep this file ASCII-only (VBScript is not UTF-8 aware).
Option Explicit
If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
End If
Dim scriptPath, shell
scriptPath = WScript.Arguments(0)
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """", 0, False
