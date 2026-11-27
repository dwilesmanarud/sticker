@echo off
title Sound Sticker Bot - Mode Publik (Internet)
cd /d "%~dp0"

echo ========================================================
echo   WhatsApp Sound Sticker Bot - Mode Akses Publik (HTTPS)
echo   Developer: Rudi Dwi Lesmana
echo ========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js tidak ditemukan di PATH!
  pause
  exit /b 1
)

set "CF_BIN=cloudflared"
where cloudflared >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" (
    set "CF_BIN=C:\Program Files (x86)\cloudflared\cloudflared.exe"
  ) else if exist "C:\Program Files\cloudflared\cloudflared.exe" (
    set "CF_BIN=C:\Program Files\cloudflared\cloudflared.exe"
  ) else (
    echo [!] cloudflared belum terpasang. Pasang dengan: winget install Cloudflare.cloudflared
    pause
    exit /b 1
  )
)

node scripts/patch-fps.js
echo Menjalankan Cloudflare Tunnel di jendela terpisah...
echo Salin link https://xxxx.trycloudflare.com yang muncul untuk dibuka & di-install di HP!
start "Cloudflare Tunnel - Sound Sticker Bot" cmd /k ""%CF_BIN%" tunnel --protocol http2 --url http://localhost:3000"

start "" /min cmd /c "ping -n 3 127.0.0.1 >nul && start http://localhost:3000"
node index.js
pause