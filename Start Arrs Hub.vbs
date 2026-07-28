' Silent launcher — double-click this (or a Desktop shortcut to it).
' Starts Arrs Hub with a normal app window and a tray icon (like Sonarr/Radarr).
Option Explicit
Dim sh, fso, folder, bat
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
bat = Chr(34) & folder & "\Start Arrs Hub.bat" & Chr(34)
' 0 = hidden console for the bootstrap bat; Electron still shows the app window.
sh.Run bat, 0, False
