# Bot WhatsApp Stiker Bersuara + Web UI

Bot WhatsApp berbasis Node.js (ESM) menggunakan `@whiskeysockets/baileys` dan `fluent-ffmpeg` yang mengenali stiker berdasarkan hash **SHA-256** dan membalasnya secara otomatis dengan **Voice Note (`ptt: true`)**, dilengkapi **Dashboard Web HTML** agar bisa diakses dan dikelola dengan mudah dari browser maupun ponsel.

## Fitur Utama

- **Dashboard Web UI (HTML/CSS/JS + PWA):**
  - Scan **QR Code** atau minta **Pairing Code** langsung dari browser secara *real-time* (SSE).
  - **Ubah Video Bersuara jadi Stiker:** Unggah video (`MP4/MOV/WebM`) → otomatis diubah jadi stiker animasi `.webp` (512×512, maks. 7 detik) dan suaranya diekstrak menjadi Voice Note `.ogg`.
  - Bisa juga mendaftarkan suara ke stiker via **Hash SHA-256 (`.info`)**, upload `.webp` + audio, atau **rekam suara langsung dari mikrofon browser**.
  - Galeri stiker bersuara lengkap dengan pratinjau stiker animasi, unduh `.webp`, pemutar audio bawaan, pencarian, salin hash, dan hapus.
- **Bot WhatsApp Multi-Device:**
  - Menyimpan sesi di `./auth_session`.
  - Konversi audio otomatis ke **OGG Opus** (`sounds/<hash>.ogg`) memakai `fluent-ffmpeg` (dengan fallback otomatis ke `ffmpeg-static`).
  - Auto-reply Voice Note alami (status `recording` + jeda singkat) dan anti-loop (`fromMe`).

## Prasyarat

- **Node.js** v18+ (disarankan v20 atau lebih baru)
- **npm**
- **ffmpeg** (opsional — bot otomatis memakai `ffmpeg-static` jika `ffmpeg` belum terpasang secara global)

## Instalasi

```powershell
npm install
```

## Cara Menjalankan Bot & Aplikasi Web (PWA)

### Cara Paling Mudah (1-Klik di Windows)
- **Mode Lokal / Wi-Fi:** Klik dua kali **[Jalankan-Bot.bat](Jalankan-Bot.bat)** — otomatis menjalankan bot dan membuka aplikasi di browser (`http://localhost:3000`).
- **Mode Publik (Akses Semua Orang via Internet):** Klik dua kali **[Jalankan-Publik.bat](Jalankan-Publik.bat)** — otomatis menjalankan bot beserta Cloudflare Tunnel (`https://xxxx.trycloudflare.com`).

### Install Sebagai Aplikasi di HP & Laptop (PWA)
1. Buka URL aplikasi (`http://localhost:3000` di laptop, atau tautan `https://xxxx.trycloudflare.com` di HP/Android/iPhone).
2. Klik tombol **📲 Install App** di pojok kanan atas (atau di iPhone Safari: **Bagikan → Tambah ke Layar Utama**).
3. Aplikasi **Stiker Suara** akan muncul di layar utama/desktop seperti aplikasi bawaan.

### Via Terminal (Manual)
```powershell
node index.js
```
(atau `npm start`, dan `npm run start:pairing` untuk mode Pairing Code di terminal).

Saat berjalan, terminal akan menampilkan alamat akses Web UI secara otomatis:
- **Lokal (komputer ini):** `http://localhost:3000`
- **Satu Wi-Fi / LAN:** `http://<IP-LOKAL-ANDA>:3000` (misal `http://192.168.1.10:3000`)

> Anda bisa mengganti port melalui environment variable `PORT` (misal PowerShell: `$env:PORT=8080; node index.js`).

---

## Cara Membuat Web UI Bisa Diakses Semua Orang (Publik / Internet)

Server web secara default sudah mendengarkan di `0.0.0.0:3000`. Agar siapa saja di internet dapat membuka Web UI Anda:

### Opsi 1: Cloudflare Tunnel (Gratis, HTTPS Otomatis, Tanpa Port Forwarding)
1. Pasang `cloudflared` (di Windows via PowerShell):
   ```powershell
   winget install Cloudflare.cloudflared
   ```
2. Pastikan bot sedang berjalan (`node index.js`), lalu buka terminal baru dan jalankan:
   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```
3. Bagikan URL `https://xxxx.trycloudflare.com` yang muncul kepada siapa saja. Karena sudah **HTTPS**, fitur **Rekam Suara** dari mikrofon browser juga langsung berfungsi di HP maupun laptop.

### Opsi 2: Hosting / VPS (Online 24 Jam)
- Deploy proyek ini ke VPS (Ubuntu/Debian) atau layanan Node.js dengan penyimpanan persisten (untuk folder `auth_session/`, `database/`, dan `sounds/`).
- Jalankan dengan process manager seperti `pm2` (`pm2 start index.js --name sticker-bot`) di balik reverse proxy Nginx/Caddy dengan HTTPS.

---

## Daftar Perintah WhatsApp

| Perintah | Cara Pakai | Fungsi |
| :--- | :--- | :--- |
| `.ptv` / `.stikervid` | Kirim video bersuara dengan caption `.ptv` (atau reply video dengan `.ptv`) | Mengubah video jadi **Video Note bulat (`ptv`)** — animasi + suara menyatu dalam 1 bubble pesan |
| `.stiker` / `.s` | Kirim video bersuara dengan caption `.stiker` (atau reply video dengan `.stiker [nama]`) | Mengubah video jadi stiker animasi `.webp` + Voice Note instan |
| `.menu` | Kirim `.menu` | Menampilkan daftar perintah & jumlah stiker terdaftar |
| `.info` | Reply stiker → ketik `.info` | Menampilkan hash SHA-256 stiker dan status suaranya |
| `.setsuara` | **1 langkah:** Reply stiker sambil kirim dokumen audio (MP3/WAV/M4A) dengan caption `.setsuara`<br>**2 langkah (VN/audio biasa):** Reply stiker → ketik `.setsuara` → kirim Voice Note/audio (atau sebaliknya) | Mendaftarkan suara ke stiker |
| `.hapussuara` | Reply stiker → ketik `.hapussuara` | Menghapus suara terdaftar beserta file audionya |

## Struktur Folder

```text
.
├── index.js            # Entrypoint utama (memanggil src/index.js)
├── public/
│   ├── index.html      # Antarmuka Web UI
│   ├── styles.css      # Styling responsif
│   └── app.js          # Logika frontend, SSE live update, dan perekam suara
├── src/
│   ├── index.js        # Koneksi Baileys, QR/Pairing Code, dan startup Web UI
│   ├── web.js          # Server Express, REST API, dan SSE
│   ├── config.js       # Konfigurasi path, prefix, port web, dan jeda balasan
│   ├── database.js     # Baca/tulis aman database/stickers.json
│   ├── audio.js        # Konversi audio ke OGG Opus via fluent-ffmpeg
│   ├── media.js        # Unwrap pesan, download media, dan hash SHA-256
│   └── handler.js      # Router perintah dan auto-reply stiker
├── database/           # Menyimpan stickers.json (diabaikan git)
├── sounds/             # Menyimpan hasil konversi .ogg (diabaikan git)
└── auth_session/       # Menyimpan sesi login WhatsApp (diabaikan git)
```
