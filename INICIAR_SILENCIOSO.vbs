Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
WshShell.Run "cmd /c node server.js", 0, False
WScript.Sleep 2000
WshShell.Run "http://localhost:8765"
