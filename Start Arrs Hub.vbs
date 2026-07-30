' Silent launcher — double-click this (or a Desktop shortcut to it).
' Starts Arrs Hub with a normal app window and a tray icon (like Sonarr/Radarr).
Option Explicit
Dim sh, fso, folder, bat, needBootstrap
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = folder
bat = Chr(34) & folder & "\Start Arrs Hub.bat" & Chr(34)

' First run needs a visible console so npm install / build errors aren't hidden.
needBootstrap = False
If Not fso.FolderExists(folder & "\node_modules\express") Then needBootstrap = True
If Not fso.FileExists(folder & "\dist\index.html") Then needBootstrap = True
If Not fso.FileExists(folder & "\node_modules\electron\dist\electron.exe") Then needBootstrap = True

If needBootstrap Then
  ' 1 = normal window, True = wait until bat finishes (install/build/start).
  sh.Run bat, 1, True
Else
  ' 0 = hidden console; Electron still shows the app window.
  sh.Run bat, 0, False
End If
