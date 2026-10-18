@echo off
setlocal
cd /d "%~dp0"
echo YouTube Live Dub - Windows setup
echo Downloads tools and models. Keep this window open until setup finishes.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1" %*
set "DUB_EXIT=%ERRORLEVEL%"
if not "%DUB_EXIT%"=="0" echo Setup failed. Read the error above, then run this file again.
pause
exit /b %DUB_EXIT%
