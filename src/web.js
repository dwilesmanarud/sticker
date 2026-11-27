import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { AUDIO_EXTENSIONS, PATHS, VIDEO_EXTENSIONS, WEB_CONFIG } from './config.js';
import {
  convertToVoiceNote,
  convertVideoToSoundSticker,
  removeAudioFile,
} from './audio.js';
import {
  deleteSticker,
  getSticker,
  listStickers,
  resolveAudioFullPath,
  setSticker,
} from './database.js';
import { computeSha256 } from './media.js';

const SHA256_REGEX = /^[a-f0-9]{64}$/;

/**
 * Mengembalikan daftar alamat IPv4 lokal agar pengguna tahu URL akses
 * dari HP/perangkat lain di jaringan yang sama.
 */
export function getLanAddresses(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

function guessAudioExt(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return ext;
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('ogg') || mime.includes('opus')) return '.ogg';
  if (mime.includes('webm')) return '.webm';
  return '.audio';
}

function guessVideoExt(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return ext;
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
  if (mime.includes('matroska') || mime.includes('mkv')) return '.mkv';
  return '.mp4';
}

export function startWebServer(sessionManager) {
  const app = express();
  app.use(express.json());
  app.use(
    express.static(PATHS.publicDir, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: WEB_CONFIG.maxUploadBytes },
  });

  // Ringkasan platform & daftar seluruh sesi bot
  app.get('/api/overview', async (_req, res) => {
    try {
      const overview = await sessionManager.getOverview();
      res.json({
        ...overview,
        lanUrls: getLanAddresses(WEB_CONFIG.port),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live updates via Server-Sent Events (SSE)
  app.get('/api/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent('sessions', await sessionManager.getOverview());
    const unsubscribe = sessionManager.subscribe((event, payload) => {
      sendEvent(event, payload);
    });

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // === MULTI-SESSION ("JADI BOT") ENDPOINTS ===

  app.post('/api/sessions', async (req, res) => {
    try {
      const { name, prefix, features } = req.body || {};
      const session = await sessionManager.createSession({ name, prefix, features });
      res.status(201).json({ session });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/sessions/:id', async (req, res) => {
    try {
      const { name, prefix, features } = req.body || {};
      const session = await sessionManager.updateSession(req.params.id, {
        name,
        prefix,
        features,
      });
      res.json({ session });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/pairing', async (req, res) => {
    try {
      const code = await sessionManager.requestPairingCode(req.params.id, req.body?.phone);
      res.json({ code });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/reset', async (req, res) => {
    try {
      const session = await sessionManager.resetSession(req.params.id);
      res.json({ ok: true, session });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const result = await sessionManager.deleteSession(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // === STICKER STUDIO & GALLERY ENDPOINTS ===

  app.get('/api/stickers', async (_req, res) => {
    try {
      const stickers = await listStickers();
      res.json({ stickers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(
    '/api/stickers',
    upload.fields([
      { name: 'sticker', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const audioFile = req.files?.audio?.[0];
        const stickerFile = req.files?.sticker?.[0];
        const rawHash = String(req.body?.hash || '').trim().toLowerCase();
        const label = String(req.body?.label || '').trim().slice(0, 60);

        if (!audioFile) {
          return res.status(400).json({ error: 'File audio atau rekaman suara wajib diisi.' });
        }

        let hash = '';
        if (rawHash) {
          if (!SHA256_REGEX.test(rawHash)) {
            return res.status(400).json({
              error: 'Hash SHA-256 tidak valid. Harus berupa 64 karakter heksadesimal (0-9, a-f).',
            });
          }
          hash = rawHash;
        } else if (stickerFile) {
          hash = computeSha256(stickerFile.buffer);
        } else {
          return res.status(400).json({
            error: 'Isi Hash SHA-256 stiker (dari perintah .info) atau unggah file stiker .webp.',
          });
        }

        const outputFileName = `${hash}.ogg`;
        const converted = await convertToVoiceNote(
          audioFile.buffer,
          outputFileName,
          guessAudioExt(audioFile)
        );

        const saved = await setSticker(hash, {
          label: label || `Stiker ${hash.slice(0, 8)}`,
          audioPath: converted.relativePath,
          fileName: converted.fileName,
          originalMime: audioFile.mimetype || 'audio/mpeg',
          createdBy: 'web-ui',
          createdAt: new Date().toISOString(),
        });

        await sessionManager.notifyStickersChanged();
        res.status(201).json({ sticker: saved });
      } catch (err) {
        res.status(500).json({ error: `Gagal memproses audio: ${err.message}` });
      }
    }
  );

  app.post('/api/stickers/from-video', upload.single('video'), async (req, res) => {
    try {
      const videoFile = req.file;
      const label = String(req.body?.label || '').trim().slice(0, 60);

      if (!videoFile) {
        return res.status(400).json({ error: 'File video wajib diunggah.' });
      }

      const result = await convertVideoToSoundSticker(videoFile.buffer, guessVideoExt(videoFile));

      if (!result.hasAudioTrack || !result.audio) {
        await removeAudioFile(result.stickerFullPath);
        return res.status(400).json({
          error: 'Video ini tidak memiliki trek suara/audio. Unggah video yang bersuara.',
        });
      }

      const saved = await setSticker(result.hash, {
        label: label || `Stiker Video ${result.hash.slice(0, 8)}`,
        audioPath: result.audio.relativePath,
        fileName: result.audio.fileName,
        stickerPath: result.stickerRelativePath,
        originalMime: videoFile.mimetype || 'video/mp4',
        createdBy: 'web-ui',
        createdAt: new Date().toISOString(),
      });

      await sessionManager.notifyStickersChanged();
      res.status(201).json({ sticker: saved });
    } catch (err) {
      res.status(500).json({ error: `Gagal mengonversi video: ${err.message}` });
    }
  });

  app.get('/api/stickers/:hash/sticker', async (req, res) => {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!SHA256_REGEX.test(hash)) {
      return res.status(400).json({ error: 'Hash tidak valid.' });
    }

    const record = await getSticker(hash);
    if (!record?.stickerPath) {
      return res.status(404).json({ error: 'Pratinjau stiker tidak tersedia.' });
    }

    const fullPath = resolveAudioFullPath(record.stickerPath);
    try {
      await fs.access(fullPath);
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'File stiker tidak ditemukan di server.' });
    }
  });

  app.get('/api/stickers/:hash/audio', async (req, res) => {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!SHA256_REGEX.test(hash)) {
      return res.status(400).json({ error: 'Hash tidak valid.' });
    }

    const record = await getSticker(hash);
    if (!record) {
      return res.status(404).json({ error: 'Stiker tidak ditemukan.' });
    }

    const fullPath = resolveAudioFullPath(record.audioPath);
    try {
      await fs.access(fullPath);
      res.setHeader('Content-Type', 'audio/ogg');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'File audio tidak ditemukan di server.' });
    }
  });

  app.delete('/api/stickers/:hash', async (req, res) => {
    const hash = String(req.params.hash || '').toLowerCase();
    if (!SHA256_REGEX.test(hash)) {
      return res.status(400).json({ error: 'Hash tidak valid.' });
    }

    const removed = await deleteSticker(hash);
    if (!removed) {
      return res.status(404).json({ error: 'Stiker tidak ditemukan.' });
    }

    await removeAudioFile(resolveAudioFullPath(removed.audioPath));
    await removeAudioFile(resolveAudioFullPath(removed.stickerPath));
    await sessionManager.notifyStickersChanged();
    res.json({ deleted: true, hash });
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload gagal: ${err.message}` });
    }
    res.status(500).json({ error: err?.message || 'Terjadi kesalahan server.' });
  });

  const server = app.listen(WEB_CONFIG.port, WEB_CONFIG.host, () => {
    const lanUrls = getLanAddresses(WEB_CONFIG.port);
    console.log(`\n🌐 Platform Bot WhatsApp (Jadi Bot) berjalan di:`);
    console.log(`   • Lokal : http://localhost:${WEB_CONFIG.port}`);
    for (const url of lanUrls) {
      console.log(`   • Jaringan (LAN/Wi-Fi): ${url}`);
    }
    console.log(
      `   • Publik (Internet): jalankan Cloudflare Tunnel (cloudflared tunnel --url http://localhost:${WEB_CONFIG.port})\n`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `❌ Port ${WEB_CONFIG.port} sudah dipakai oleh proses lain! Tutup jendela bot lama atau jalankan dengan port lain (mis. PORT=3001).`
      );
      process.exit(1);
    }
    console.error('❌ Error server Web UI:', err.message);
  });

  return server;
}
