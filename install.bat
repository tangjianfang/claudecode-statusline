@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Please install Node.js and try again.
    exit /b 1
)

node "%~dp0statusline.js" --install
if errorlevel 1 (
    echo Installation failed.
    exit /b 1
)

echo Done. Restart Claude Code to see the new status line.
endlocal
