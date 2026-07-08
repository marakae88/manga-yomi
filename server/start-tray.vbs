' Silent launcher: starts the web-manga-ocr OCR server as a tray icon,
' no console window. For auto-start on login, put a shortcut to this
' file in shell:startup.
Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(here & "\venv\Scripts\pythonw.exe") Then
    MsgBox "venv not found - run run-server.bat once first to install dependencies.", 48, "web-manga-ocr"
    WScript.Quit 1
End If

sh.Run """" & here & "\venv\Scripts\pythonw.exe"" """ & here & "\server.py"" --tray", 0, False
