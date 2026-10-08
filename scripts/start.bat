@echo off
REM start.bat — Windows double-click launcher for Privacy Vision Agent
cd /d "%~dp0.."
echo Starting Privacy Vision Agent server...
echo Open http://127.0.0.1:8787/ in your browser
node server\app\server.js
pause
