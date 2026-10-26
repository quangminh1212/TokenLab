@echo off
if defined RUN_BAT_HEADLESS goto :run_bat_main
if /I "%~1"=="--console" goto :run_bat_main
set "HIDE_VBS=%TEMP%\dev-run-hidden-%RANDOM%.vbs"
> "%HIDE_VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%HIDE_VBS%" echo Set fso = CreateObject("Scripting.FileSystemObject")
>> "%HIDE_VBS%" echo q = Chr(34)
>> "%HIDE_VBS%" echo bat = WScript.Arguments(0)
>> "%HIDE_VBS%" echo args = ""
>> "%HIDE_VBS%" echo For i = 1 To WScript.Arguments.Count - 1
>> "%HIDE_VBS%" echo   a = WScript.Arguments(i)
>> "%HIDE_VBS%" echo   If InStr(a, " ") ^> 0 Or InStr(a, q) ^> 0 Or InStr(a, "&") ^> 0 Then
>> "%HIDE_VBS%" echo     args = args ^& " " ^& q ^& Replace(a, q, q ^& q) ^& q
>> "%HIDE_VBS%" echo   Else
>> "%HIDE_VBS%" echo     args = args ^& " " ^& a
>> "%HIDE_VBS%" echo   End If
>> "%HIDE_VBS%" echo Next
>> "%HIDE_VBS%" echo logDir = sh.ExpandEnvironmentStrings("%%LOCALAPPDATA%%") ^& "\dev-run-logs"
>> "%HIDE_VBS%" echo If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
>> "%HIDE_VBS%" echo safeName = Replace(Replace(bat, ":", ""), "\", "_")
>> "%HIDE_VBS%" echo logPath = logDir ^& "\" ^& safeName ^& ".log"
>> "%HIDE_VBS%" echo launcher = sh.ExpandEnvironmentStrings("%%TEMP%%") ^& "\dev-run-" ^& Replace(Replace(CStr(Timer), ".", ""), ",", "") ^& ".cmd"
>> "%HIDE_VBS%" echo Set tf = fso.CreateTextFile(launcher, True)
>> "%HIDE_VBS%" echo tf.WriteLine "@echo off"
>> "%HIDE_VBS%" echo tf.WriteLine "set RUN_BAT_HEADLESS=1"
>> "%HIDE_VBS%" echo tf.WriteLine "cd /d " ^& q ^& fso.GetParentFolderName(bat) ^& q
>> "%HIDE_VBS%" echo tf.WriteLine "call " ^& q ^& bat ^& q ^& args ^& " > " ^& q ^& logPath ^& q ^& " 2>&1"
>> "%HIDE_VBS%" echo tf.Close
>> "%HIDE_VBS%" echo sh.CurrentDirectory = fso.GetParentFolderName(bat)
>> "%HIDE_VBS%" echo sh.Run q ^& launcher ^& q, 0, False
wscript.exe //B //NoLogo "%HIDE_VBS%" "%~f0" %*
del "%HIDE_VBS%" >nul 2>&1
exit /b 0
:run_bat_main
if /I "%~1"=="--console" shift
setlocal EnableExtensions
cd /d "%~dp0"

title TokenLab (hot reload)
echo.
echo  === TokenLab ===
echo  Dev server + hot reload (tsx watch)
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 20+ then retry.
  if not defined RUN_BAT_HEADLESS pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Install Node.js 20+ then retry.
  if not defined RUN_BAT_HEADLESS pause
  exit /b 1
)

echo [1/2] Installing dependencies...
if not exist "node_modules\" (
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    if not defined RUN_BAT_HEADLESS pause
    exit /b 1
  )
) else (
  echo       node_modules OK
)

if not exist "node_modules\tsx\" (
  echo       Installing tsx...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    if not defined RUN_BAT_HEADLESS pause
    exit /b 1
  )
)

echo [2/2] Starting hot-reload server on http://127.0.0.1:3737
echo       Watching: src\
echo       Edit code -^> server auto-restarts
echo       Press Ctrl+C to stop.
echo.

start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:3737"
call npm run serve:watch
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Server exited with code %EXITCODE%
  if not defined RUN_BAT_HEADLESS pause
)
exit /b %EXITCODE%
