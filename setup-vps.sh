#!/usr/bin/env bash
set -e

echo "========================================================"
echo "  Setup WhatsApp Sound Sticker Bot di InstaBox Linux"
echo "  Developer: Rudi Dwi Lesmana"
echo "========================================================"

# 1. Install ffmpeg & curl jika belum ada
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[1/4] Memasang ffmpeg..."
  sudo apt-get update -y
  sudo apt-get install -y ffmpeg curl ca-certificates
else
  echo "[1/4] ffmpeg sudah terpasang: $(ffmpeg -version | head -n 1)"
fi

# 2. Install Node.js 20 jika belum ada atau versinya < 20
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ]; then
    NEED_NODE=1
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  echo "[2/4] Memasang Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[2/4] Node.js sudah siap: $(node -v)"
fi

# 3. Install PM2 & dependensi proyek + patch 24 FPS / 15 detik / 1000 KiB
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[3/4] Memasang PM2..."
  sudo npm install -g pm2
fi

echo "[3/4] Memasang dependensi npm & menerapkan patch..."
npm install
node scripts/patch-fps.js

# 4. Jalankan bot 24 jam lewat PM2
echo "[4/4] Menjalankan bot dengan PM2..."
pm2 delete sticker-bot >/dev/null 2>&1 || true
pm2 start index.js --name sticker-bot
pm2 save

echo ""
echo "========================================================"
echo "  ✅ Bot berhasil berjalan di InstaBox Linux!"
echo "  • Cek log  : pm2 logs sticker-bot"
echo "  • Restart  : pm2 restart sticker-bot"
echo "  • Status   : pm2 status"
echo "  • Port Web : http://localhost:3000"
echo "========================================================"
