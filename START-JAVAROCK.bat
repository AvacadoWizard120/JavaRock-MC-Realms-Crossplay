@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-JavaRock.ps1"
set "JAVAROCK_EXIT=%ERRORLEVEL%"

if not "%JAVAROCK_EXIT%"=="0" (
  echo.
  echo JavaRock did not start. Review the message above, then try again.
  pause
)

exit /b %JAVAROCK_EXIT%
