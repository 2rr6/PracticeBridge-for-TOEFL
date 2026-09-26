@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "PRACTICEBRIDGE_TEST_HIDDEN="
cd /d "%~dp0"
if exist "%~dp0dist\PracticeBridge-win32-x64\PracticeBridge.exe" goto portable
if exist "%~dp0node_modules\electron\dist\electron.exe" goto source
echo PracticeBridge runtime was not found. Please see README.md.
pause
exit /b 1
:portable
start "" /D "%~dp0dist\PracticeBridge-win32-x64" "%~dp0dist\PracticeBridge-win32-x64\PracticeBridge.exe"
exit /b
:source
start "" /D "%~dp0" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b
