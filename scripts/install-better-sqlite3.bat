@echo off
setlocal
cd /d "%~dp0.."
echo [1/3] Node version:
node --version
if errorlevel 1 goto ERROR
echo [2/3] Installing better-sqlite3 (requires internet for npm)...
call npm install better-sqlite3@12.4.1 --save-exact
if errorlevel 1 goto ERROR
echo [3/3] Installation completed.
node scripts\check-db.js
if errorlevel 1 goto ERROR
echo DONE
pause
exit /b 0
:ERROR
echo ERROR - check messages above. No restart until this is resolved.
pause
exit /b 1
