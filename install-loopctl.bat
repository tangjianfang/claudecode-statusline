@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Please install Node.js and try again.
    exit /b 1
)

node "%~dp0loopctl.js" --install
if errorlevel 1 (
    echo Installation failed.
    exit /b 1
)

echo Done. Run "loopctl on" in a project directory to enable the auto-loop there.
endlocal
