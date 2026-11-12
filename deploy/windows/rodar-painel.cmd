@echo off
cd /d "%~dp0..\.."
:loop
"C:\Program Files\nodejs\node.exe" --watch-path=server --watch-preserve-output  server\index.js >> log\console.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
