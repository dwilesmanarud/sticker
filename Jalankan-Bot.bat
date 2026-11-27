@echo off
title Sound Sticker Bot - Rudi Dwi Lesmana
cd /d "%~dp0"

echo ========================================================
echo   WhatsApp Sound Sticker Bot (24 FPS) - Web App (PWA)
echo   Developer: Rudi Dwi Lesmana
echo ========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan di PATH!
  pause
  exit /b 1
)

node scripts/patch-fps.js
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul && start http://localhost:3000"
node index.js
echo.
echo Bot berhenti. Tekan tombol apa saja untuk menutup jendela ini.
pause