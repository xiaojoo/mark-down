@echo off
rem mdkit launcher -- a standalone application window (no tab strip, no address bar)
rem running on its OWN browser profile, so it never touches the browser you use day to day.
rem Normal window: title bar, min/max/close, taskbar button. F11 if you ever want full screen.
setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "URL=file:///%ROOT%\app\index.html"
set "URL=%URL:\=/%"
rem The profile lives in %LOCALAPPDATA%, NOT inside the project: a Chrome profile is
rem 100MB+ of other people's *.test.js, and a stray copy inside the tree poisons npm test.
set "PROFILE=%LOCALAPPDATA%\mdkit"

set "EXE="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined EXE if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined EXE if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" set "EXE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not defined EXE if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" set "EXE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if not defined EXE (
    echo mdkit: no Chrome or Edge found in the usual places.
    echo Open %ROOT%\app\index.html in any browser instead.
    pause
    exit /b 1
)

start "" "%EXE%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check ^
    --window-size=1280,860 --window-position=120,80 --app="%URL%"
exit /b 0
