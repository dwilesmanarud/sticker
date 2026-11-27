import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  convertVideoToSoundSticker,
  downloadMediaMessage,
  downloadVideoForSoundSticker,
  sendVideoAsSoundSticker,
  useMultiFileAuthState,
} = await import('@xbibzlibrary/whatsbibz');
const { default: pino } = await import('pino');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_ROOT_DIR = path.join(__dirname, 'auth');
const DB_DIR = path.join(__dirname, 'database');
const STICKERS_DIR = path.join(__dirname, 'stickers');
const SOUNDS_DIR = path.join(__dirname, 'sounds');
const SESSIONS_DB_FILE = path.join(DB_DIR, 'wa_sessions.json');
const CREATED_STICKERS_FILE = path.join(DB_DIR, 'created_stickers.json');
const DEVELOPER_NAME = 'Rudi Dwi Lesmana';
const WEB_HOST = process.env.HOST || '0.0.0.0';
const WEB_PORT = Number(process.env.PORT || 3000);
const MAX_SESSIONS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLanAddresses(port) {
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

function formatIndonesianPhone(raw) {
  let phone = String(raw || '').replace(/\D/g, '');
  if (phone.startsWith('0')) {
    phone = `62${phone.slice(1)}`;
  }
  return phone;
}

// Deteksi binary ffmpeg & ffprobe (prioritas sistem PATH, fallback otomatis ke ffmpeg-static / ffprobe-static)
async function resolveMediaBinaries() {
  let ffmpegPath = 'ffmpeg';
  let ffprobePath = 'ffprobe';

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    try {
      const mod = await import('ffmpeg-static');
      if (typeof mod.default === 'string' && mod.default) {
        ffmpegPath = mod.default;
      }
    } catch {
      // Gunakan default 'ffmpeg'
    }
  }

  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    try {
      const mod = await import('ffprobe-static');
      const resolved = mod.default?.path || mod.path;
      if (typeof resolved === 'string' && resolved) {
        ffprobePath = resolved;
      }
    } catch {
      // Gunakan default 'ffprobe'
    }
  }

  return { ffmpegPath, ffprobePath };
}

const { ffmpegPath, ffprobePath } = await resolveMediaBinaries();
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// Sesi sementara 2 langkah untuk perintah .gantisuara di WhatsApp (berlaku 2 menit)
const pendingCustomAudio = new Map();

/**
 * Menggabungkan video (MP4/MOV) dengan trek audio kustom (MP3/WAV/M4A/OGG/WebM/VN)
 * menjadi buffer MP4 baru agar bisa langsung diproses oleh sendVideoAsSoundSticker.
 */
async function mergeVideoWithCustomAudio(videoBuffer, audioBuffer, audioExt = '.audio') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-custom-audio-'));
  const safeExt = audioExt.startsWith('.') ? audioExt : `.${audioExt}`;
  const videoIn = path.join(dir, 'in.mp4');
  const audioIn = path.join(dir, `in${safeExt}`);
  const mergedOut = path.join(dir, 'merged.mp4');

  try {
    await fs.writeFile(videoIn, videoBuffer);
    await fs.writeFile(audioIn, audioBuffer);

    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        [
          '-y',
          '-i',
          videoIn,
          '-i',
          audioIn,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '48000',
          '-ac',
          '1',
          '-shortest',
          '-movflags',
          '+faststart',
          mergedOut,
        ],
        { windowsHide: true, timeout: 45_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Gagal menggabungkan video & audio kustom: ${stderr?.slice(-200) || err.message}`));
          } else {
            resolve();
          }
        }
      );
    });

    return await fs.readFile(mergedOut);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function guessAudioExtFromMime(mime = '', originalName = '') {
  const ext = path.extname(originalName || '').toLowerCase();
  if (['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.aac', '.webm', '.flac'].includes(ext)) return ext;
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a';
  if (m.includes('ogg') || m.includes('opus')) return '.ogg';
  if (m.includes('webm')) return '.webm';
  return '.audio';
}

function unwrapWaMessage(message) {
  let current = message;
  while (current) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return current || null;
}

function hasAudioPayload(unwrapped) {
  if (!unwrapped) return false;
  if (unwrapped.audioMessage) return true;
  const doc = unwrapped.documentMessage;
  if (!doc) return false;
  const mime = (doc.mimetype || '').toLowerCase();
  const ext = path.extname(doc.fileName || '').toLowerCase();
  return mime.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.aac'].includes(ext);
}

// State bersama multi-nomor antara bot WhatsApp & Web App (SSE)
const sessions = new Map();
const sseClients = new Set();
const activityLogs = [];
const stats = {
  stickersCreated: 0,
  pingsHandled: 0,
};
let registryWriteQueue = Promise.resolve();
let stickersWriteQueue = Promise.resolve();
let createdStickers = [];

async function loadCreatedStickers() {
  await fs.mkdir(DB_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(CREATED_STICKERS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    createdStickers = Array.isArray(parsed) ? parsed : [];
  } catch {
    createdStickers = [];
  }
  stats.stickersCreated = createdStickers.length;
}

function saveCreatedStickersFile() {
  const snapshot = JSON.stringify(createdStickers, null, 2) + '\n';
  stickersWriteQueue = stickersWriteQueue.then(async () => {
    await fs.mkdir(DB_DIR, { recursive: true });
    const tmp = `${CREATED_STICKERS_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, CREATED_STICKERS_FILE);
  });
  return stickersWriteQueue;
}

async function archiveCreatedSticker({ stickerBuffer, audioBuffer, seconds, source, name }) {
  await fs.mkdir(STICKERS_DIR, { recursive: true });
  await fs.mkdir(SOUNDS_DIR, { recursive: true });
  const id = `stk_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  await fs.writeFile(path.join(STICKERS_DIR, `${id}.webp`), stickerBuffer);
  await fs.writeFile(path.join(SOUNDS_DIR, `${id}.ogg`), audioBuffer);

  const entry = {
    id,
    name: String(name || `Sound Sticker ${id.slice(-4)}`).slice(0, 50),
    source: source || 'Web',
    seconds: seconds || 0,
    stickerBytes: stickerBuffer.length,
    audioBytes: audioBuffer.length,
    createdAt: new Date().toISOString(),
  };

  createdStickers.unshift(entry);
  stats.stickersCreated = createdStickers.length;
  await saveCreatedStickersFile();
  broadcast('stickers', { stickers: createdStickers });
  broadcast('status', getStatusSnapshot());
  return entry;
}

async function removeCreatedSticker(id) {
  const idx = createdStickers.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  createdStickers.splice(idx, 1);
  stats.stickersCreated = createdStickers.length;
  await saveCreatedStickersFile();
  await fs.rm(path.join(STICKERS_DIR, `${id}.webp`), { force: true }).catch(() => {});
  await fs.rm(path.join(SOUNDS_DIR, `${id}.ogg`), { force: true }).catch(() => {});
  broadcast('stickers', { stickers: createdStickers });
  broadcast('status', getStatusSnapshot());
  return true;
}

function broadcast(event, payload) {
  for (const send of sseClients) {
    send(event, payload);
  }
}

function serializeSession(rec) {
  return {
    id: rec.id,
    name: rec.name,
    status: rec.status, // connecting | pairing | open | close
    user: rec.user,
    lastPairingCode: rec.lastPairingCode,
    lastPairingPhone: rec.lastPairingPhone,
    createdAt: rec.createdAt,
  };
}

function getStatusSnapshot() {
  const list = [...sessions.values()]
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map(serializeSession);

  return {
    developer: DEVELOPER_NAME,
    fps: 24,
    maxSeconds: 15,
    totalCount: list.length,
    activeCount: list.filter((s) => s.status === 'open').length,
    sessions: list,
    stats: { ...stats },
    lanUrls: getLanAddresses(WEB_PORT),
    logs: activityLogs.slice(0, 25),
  };
}

function pushLog(message) {
  const entry = {
    time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
    message,
  };
  activityLogs.unshift(entry);
  if (activityLogs.length > 35) activityLogs.pop();
  broadcast('status', getStatusSnapshot());
}

function printStartupBanner() {
  console.log('========================================================');
  console.log('   🎵 WhatsApp Sound Sticker Bot (24 FPS · Multi-Nomor)');
  console.log(`   👨‍💻 Developer : ${DEVELOPER_NAME}`);
  console.log('========================================================');
  console.log('   Fitur & Perintah:');
  console.log('   • .menu       - Menampilkan info developer & daftar fitur');
  console.log('   • .ping       - Cek status bot (balas pong)');
  console.log('   • .Sticker    - Ubah video bersuara jadi sound sticker');
  console.log('   • .gantisuara - Ubah video jadi sound sticker dengan suara sendiri');
  console.log('========================================================\n');
}

function buildMenuText() {
  return [
    '🎵 *WhatsApp Sound Sticker Bot*',
    `👨‍💻 *Developer:* ${DEVELOPER_NAME}`,
    '',
    '*Daftar Fitur & Perintah:*',
    '• `.menu` — Menampilkan menu & daftar fitur bot',
    '• `.ping` — Mengecek apakah bot sedang aktif (`pong`)',
    '• `.Sticker` — Mengubah video bersuara menjadi *Sound Sticker*',
    '• `.gantisuara` — Mengganti suara video dengan *Voice Note / audio sendiri* lalu jadi Sound Sticker',
    '',
    '*Cara Pakai `.Sticker`:*',
    '1. Kirim video MP4/MOV yang ada suaranya dengan caption `.Sticker`, atau',
    '2. Reply video bersuara di chat lalu ketik `.Sticker`.',
    '',
    '*Cara Pakai `.gantisuara`:*',
    '1. Kirim/reply video dengan `.gantisuara`.',
    '2. Lalu kirim *Voice Note* atau *file audio* (MP3/WAV/M4A) sebagai suara penggantinya.',
    '',
    '_Catatan: Untuk akun sendiri, perintah aktif di self-chat._',
  ].join('\n');
}

function normalizeUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function isSelfChat(remoteJid, sock) {
  if (!remoteJid) return false;
  const target = normalizeUser(remoteJid);
  const myPhone = normalizeUser(sock.user?.id);
  const myLid = normalizeUser(sock.user?.lid);
  return Boolean(target && (target === myPhone || (myLid && target === myLid)));
}

function extractText(message) {
  if (!message) return '';
  let current = message;
  while (current) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else break;
  }
  return (
    current?.conversation ||
    current?.extendedTextMessage?.text ||
    current?.videoMessage?.caption ||
    current?.imageMessage?.caption ||
    ''
  ).trim();
}

function saveRegistry() {
  const data = {};
  for (const [id, rec] of sessions.entries()) {
    data[id] = {
      id: rec.id,
      name: rec.name,
      authDir: rec.authDir,
      createdAt: rec.createdAt,
    };
  }
  const snapshot = JSON.stringify(data, null, 2) + '\n';
  registryWriteQueue = registryWriteQueue.then(async () => {
    await fs.mkdir(DB_DIR, { recursive: true });
    const tmp = `${SESSIONS_DB_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, SESSIONS_DB_FILE);
  });
  return registryWriteQueue;
}

async function loadRegistry() {
  await fs.mkdir(DB_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(SESSIONS_DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function createRecord({ id, name, authDir, createdAt }) {
  return {
    id,
    name: String(name || id).trim().slice(0, 40) || id,
    authDir,
    createdAt: createdAt || new Date().toISOString(),
    status: 'connecting',
    user: null,
    lastPairingCode: null,
    lastPairingPhone: null,
    sock: null,
    reconnectTimer: null,
    isResetting: false,
    isDeleted: false,
  };
}

async function stopSessionSocket(rec, shouldLogout = false) {
  if (rec.reconnectTimer) {
    clearTimeout(rec.reconnectTimer);
    rec.reconnectTimer = null;
  }
  const sockToClose = rec.sock;
  const wasOpen = rec.status === 'open';
  rec.sock = null;

  if (sockToClose) {
    if (shouldLogout && wasOpen) {
      try {
        await Promise.race([sockToClose.logout(), sleep(3000)]);
      } catch {
        // Abaikan jika logout timeout
      }
    }
    try {
      sockToClose.end(undefined);
    } catch {
      // Abaikan
    }
    await sleep(300);
  }
}

async function clearSessionAuth(rec) {
  // Jika memakai root 'auth' (legacy nomor utama), hapus hanya file creds/key di dalamnya agar subfolder nomor lain aman
  if (path.resolve(rec.authDir) === path.resolve(AUTH_ROOT_DIR)) {
    const entries = await fs.readdir(AUTH_ROOT_DIR, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.isFile()) {
        await fs
          .rm(path.join(AUTH_ROOT_DIR, ent.name), { force: true, maxRetries: 5, retryDelay: 200 })
          .catch(() => {});
      }
    }
    return;
  }

  await fs.rm(rec.authDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  await fs.mkdir(rec.authDir, { recursive: true });
}

async function resetSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error('Sesi tidak ditemukan.');
  if (rec.isResetting) return serializeSession(rec);

  rec.isResetting = true;
  try {
    rec.status = 'connecting';
    rec.user = null;
    rec.lastPairingCode = null;
    rec.lastPairingPhone = null;
    pushLog(`🔄 [${rec.name}] Melepas pairing & mereset sesi...`);

    await stopSessionSocket(rec, true);
    await clearSessionAuth(rec);
  } finally {
    rec.isResetting = false;
  }

  if (!rec.isDeleted) {
    await connectSession(rec.id);
  }
  return serializeSession(rec);
}

async function deleteSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error('Sesi tidak ditemukan.');

  rec.isDeleted = true;
  rec.isResetting = true;
  await stopSessionSocket(rec, true);
  await clearSessionAuth(rec);

  if (path.resolve(rec.authDir) !== path.resolve(AUTH_ROOT_DIR)) {
    await fs.rm(rec.authDir, { recursive: true, force: true }).catch(() => {});
  }

  sessions.delete(sessionId);
  await saveRegistry();
  pushLog(`🗑️ [${rec.name}] Sesi dihapus.`);
  return { deleted: true, id: sessionId };
}

async function requestPairingForSession(sessionId, rawPhone) {
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error('Sesi tidak ditemukan.');
  if (rec.status === 'open') {
    throw new Error(`Sesi "${rec.name}" sudah terhubung.`);
  }

  const phone = formatIndonesianPhone(rawPhone);
  if (phone.length < 10 || phone.length > 16) {
    throw new Error('Masukkan nomor WhatsApp yang valid (10–16 digit), misal 081234567890.');
  }

  // Pastikan socket sedang aktif dan siap menerima requestPairingCode
  if (!rec.sock) {
    await connectSession(rec.id);
  }

  // Tunggu maksimal 8 detik hingga WebSocket WhatsApp benar-benar siap menerima pairing (status === 'pairing')
  for (let i = 0; i < 32; i++) {
    if (rec.sock && rec.status === 'pairing') break;
    await sleep(250);
  }

  if (!rec.sock) {
    throw new Error('Socket WhatsApp belum siap. Coba klik Reset Sesi lalu Minta Kode lagi.');
  }

  const rawCode = await rec.sock.requestPairingCode(phone);
  const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
  rec.lastPairingCode = formattedCode;
  rec.lastPairingPhone = phone;
  pushLog(`🔑 [${rec.name}] Pairing code untuk ${phone}: ${formattedCode}`);
  return formattedCode;
}

async function connectSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.isDeleted) return;

  if (rec.reconnectTimer) {
    clearTimeout(rec.reconnectTimer);
    rec.reconnectTimer = null;
  }

  await fs.mkdir(rec.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(rec.authDir);

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    autoFollowChannel: false,
  });

  rec.sock = sock;
  rec.status = 'connecting';
  broadcast('status', getStatusSnapshot());

  sock.ev.on('creds.update', async () => {
    if (rec.isResetting || rec.isDeleted || rec.sock !== sock) return;
    try {
      await saveCreds();
    } catch {
      // Abaikan saat reset
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (rec.sock !== sock || rec.isResetting || rec.isDeleted) return;

    if (qr) {
      const wasPairing = rec.status === 'pairing';
      rec.status = 'pairing';
      rec.user = null;
      if (!wasPairing) {
        pushLog(`🔑 [${rec.name}] Siap pairing dengan nomor HP.`);
      } else {
        broadcast('status', getStatusSnapshot());
      }
    }

    if (connection === 'open') {
      rec.status = 'open';
      rec.lastPairingCode = null;
      rec.user = {
        id: sock.user?.id || null,
        name: sock.user?.name || 'Terhubung',
      };
      pushLog(`✅ [${rec.name}] Terhubung sebagai ${rec.user.name}`);
      console.log(`✅ [${rec.name}] Bot WhatsApp terhubung (${rec.user.name})!`);
    }

    if (connection === 'close') {
      rec.status = 'close';
      rec.user = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        pushLog(`⚠️ [${rec.name}] Sesi logout (401). Mereset agar siap pairing ulang...`);
        rec.reconnectTimer = setTimeout(() => {
          resetSession(rec.id).catch((err) => console.error(`Gagal reset ${rec.id}:`, err));
        }, 1500);
        return;
      }

      pushLog(`⚠️ [${rec.name}] Terputus (kode: ${statusCode ?? 'unknown'}). Reconnect 3 dtk...`);
      rec.reconnectTimer = setTimeout(() => {
        connectSession(rec.id).catch((err) => console.error(`Gagal reconnect ${rec.id}:`, err));
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || rec.sock !== sock || rec.isDeleted) return;

    for (const msg of messages) {
      try {
        if (!msg?.message) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;

        // Pesan dari diri sendiri (fromMe) HANYA diproses di self-chat
        if (msg.key.fromMe && !isSelfChat(jid, sock)) continue;

        const text = extractText(msg.message);
        const cmd = text.toLowerCase().split(/\s+/)[0];

        if (cmd === '.menu' || cmd === '.help') {
          await sock.sendMessage(jid, { text: buildMenuText() }, { quoted: msg });
          pushLog(`📖 [${rec.name}] .menu -> ${normalizeUser(jid)}`);
          continue;
        }

        if (cmd === '.ping') {
          stats.pingsHandled += 1;
          await sock.sendMessage(jid, { text: 'pong' }, { quoted: msg });
          pushLog(`🏓 [${rec.name}] .ping -> pong (${normalizeUser(jid)})`);
          continue;
        }

        if (cmd === '.gantisuara') {
          try {
            const videoBuffer = await downloadVideoForSoundSticker(msg);
            const senderKey = `${rec.id}::${jid}::${msg.key.fromMe ? 'self' : msg.key.participant || jid}`;
            pendingCustomAudio.set(senderKey, {
              videoBuffer,
              expiresAt: Date.now() + 2 * 60 * 1000,
            });
            await sock.sendMessage(
              jid,
              {
                text: '🎬 *Video diterima!* Sekarang kirim *Voice Note* atau *file audio* (MP3/WAV/M4A) dalam 2 menit sebagai suara penggantinya.',
              },
              { quoted: msg }
            );
            pushLog(`🎧 [${rec.name}] .gantisuara menunggu audio pengganti dari ${normalizeUser(jid)}`);
          } catch (err) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Kirim atau reply video MP4/MOV dengan \`.gantisuara\` terlebih dahulu. (${err?.message || err})`,
              },
              { quoted: msg }
            );
          }
          continue;
        }

        // Cek apakah pesan ini menyelesaikan langkah ke-2 dari .gantisuara (mengirim VN/file audio)
        const unwrapped = unwrapWaMessage(msg.message);
        const senderKey = `${rec.id}::${jid}::${msg.key.fromMe ? 'self' : msg.key.participant || jid}`;
        const pending = pendingCustomAudio.get(senderKey);
        if (pending && Date.now() <= pending.expiresAt && hasAudioPayload(unwrapped)) {
          pendingCustomAudio.delete(senderKey);
          await sock.sendMessage(
            jid,
            { text: '⏳ Menggabungkan video dengan suara pilihan Anda & membuat sticker...' },
            { quoted: msg }
          );
          try {
            const audioBuffer = await downloadMediaMessage(
              { key: msg.key, message: unwrapped },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );
            const mime =
              unwrapped.audioMessage?.mimetype || unwrapped.documentMessage?.mimetype || 'audio/ogg';
            const fileName = unwrapped.documentMessage?.fileName || '';
            const mergedVideo = await mergeVideoWithCustomAudio(
              pending.videoBuffer,
              audioBuffer,
              guessAudioExtFromMime(mime, fileName)
            );
            await sendVideoAsSoundSticker(sock, jid, mergedVideo, {
              quoted: msg,
              ffmpegPath,
              ffprobePath,
            });
            pushLog(`✅ [${rec.name}] Sound sticker suara kustom terkirim ke ${normalizeUser(jid)}`);
            convertVideoToSoundSticker(mergedVideo, { ffmpegPath, ffprobePath })
              .then((conv) =>
                archiveCreatedSticker({
                  stickerBuffer: conv.sticker,
                  audioBuffer: conv.audio,
                  seconds: conv.seconds,
                  source: `WA Ganti Suara`,
                  name: `Stiker Kustom ${new Date().toLocaleTimeString('id-ID', { hour12: false })}`,
                })
              )
              .catch(() => {});
          } catch (err) {
            pushLog(`❌ [${rec.name}] .gantisuara gagal: ${err?.message || err}`);
            await sock.sendMessage(
              jid,
              { text: `❌ Gagal mengganti suara sticker: ${err?.message || err}` },
              { quoted: msg }
            );
          }
          continue;
        }

        if (cmd === '.sticker') {
          await sock.sendMessage(jid, { text: 'Sedang membuat sticker...' }, { quoted: msg });
          pushLog(`🎬 [${rec.name}] Memproses .Sticker dari ${normalizeUser(jid)}...`);
          try {
            const videoBuffer = await downloadVideoForSoundSticker(msg);
            await sendVideoAsSoundSticker(sock, jid, videoBuffer, {
              quoted: msg,
              ffmpegPath,
              ffprobePath,
            });
            pushLog(`✅ [${rec.name}] Sound sticker (24 FPS) terkirim ke ${normalizeUser(jid)}`);
            // Arsipkan ke galeri "Hasil Stiker yang Telah Dibuat" di latar belakang agar balasan WA tetap cepat
            convertVideoToSoundSticker(videoBuffer, { ffmpegPath, ffprobePath })
              .then((conv) =>
                archiveCreatedSticker({
                  stickerBuffer: conv.sticker,
                  audioBuffer: conv.audio,
                  seconds: conv.seconds,
                  source: `WA (${rec.name})`,
                  name: `Stiker WA ${new Date().toLocaleTimeString('id-ID', { hour12: false })}`,
                })
              )
              .catch(() => {});
          } catch (err) {
            pushLog(`❌ [${rec.name}] .Sticker gagal: ${err?.message || err}`);
            await sock.sendMessage(
              jid,
              { text: `❌ Gagal membuat sticker bersuara: ${err?.message || err}` },
              { quoted: msg }
            );
          }
        }
      } catch (err) {
        console.error(`⚠️ [${rec.name}] Error memproses pesan:`, err?.message || err);
      }
    }
  });
}

async function initSessions() {
  await fs.mkdir(AUTH_ROOT_DIR, { recursive: true });
  const saved = await loadRegistry();
  const entries = Object.values(saved);

  if (entries.length === 0) {
    // Pertahankan sesi lama di folder auth/ jika sudah pernah pairing
    const rec = createRecord({
      id: 'utama',
      name: 'Nomor Utama',
      authDir: AUTH_ROOT_DIR,
    });
    sessions.set(rec.id, rec);
    await saveRegistry();
  } else {
    for (const item of entries) {
      if (!item?.id) continue;
      const rec = createRecord({
        id: item.id,
        name: item.name,
        authDir: item.authDir || path.join(AUTH_ROOT_DIR, item.id),
        createdAt: item.createdAt,
      });
      sessions.set(rec.id, rec);
    }
  }

  for (const rec of sessions.values()) {
    connectSession(rec.id).catch((err) => {
      console.error(`⚠️ Gagal menyambungkan ${rec.name}:`, err.message);
    });
  }
}

function startWebApp() {
  const app = express();
  app.use(express.json());
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  app.get('/api/status', (_req, res) => {
    res.json(getStatusSnapshot());
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sseClients.add(send);
    send('status', getStatusSnapshot());

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(send);
    });
  });

  // Tambah nomor baru (+ opsional langsung minta Pairing Code dalam 1 langkah)
  app.post('/api/sessions', async (req, res) => {
    try {
      if (sessions.size >= MAX_SESSIONS) {
        return res.status(400).json({ error: `Maksimal ${MAX_SESSIONS} nomor aktif bersamaan.` });
      }
      const cleanName =
        String(req.body?.name || '').trim().slice(0, 40) || `Nomor #${sessions.size + 1}`;
      const rawPhone = String(req.body?.phone || '').trim();
      const id = `wa_${crypto.randomBytes(3).toString('hex')}`;
      const authDir = path.join(AUTH_ROOT_DIR, id);

      const rec = createRecord({ id, name: cleanName, authDir });
      sessions.set(id, rec);
      await saveRegistry();
      pushLog(`➕ Sesi baru "${cleanName}" dibuat.`);

      await connectSession(id);

      let code = null;
      if (rawPhone) {
        code = await requestPairingForSession(id, rawPhone);
      }

      res.status(201).json({
        ok: true,
        session: serializeSession(rec),
        code,
      });
    } catch (err) {
      const msg = err?.message || 'Gagal menambah nomor.';
      pushLog(`❌ Tambah nomor gagal: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  // Minta Pairing Code untuk sesi tertentu
  app.post('/api/sessions/:id/pairing', async (req, res) => {
    try {
      const code = await requestPairingForSession(req.params.id, req.body?.phone);
      res.json({ ok: true, code });
    } catch (err) {
      const msg = err?.message || 'Gagal meminta pairing code.';
      pushLog(`❌ Pairing gagal: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  // Lepas pairing / reset sesi tertentu
  app.post('/api/sessions/:id/reset', async (req, res) => {
    try {
      const session = await resetSession(req.params.id);
      res.json({ ok: true, session });
    } catch (err) {
      res.status(400).json({ error: err?.message || 'Gagal mereset sesi.' });
    }
  });

  // Hapus nomor / sesi tertentu
  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const result = await deleteSession(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err?.message || 'Gagal menghapus sesi.' });
    }
  });

  app.get('/api/created-stickers', (_req, res) => {
    res.json({ stickers: createdStickers });
  });

  app.get('/api/created-stickers/:id/webp', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^stk_[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const fullPath = path.join(STICKERS_DIR, `${id}.webp`);
    try {
      await fs.access(fullPath);
      res.setHeader('Content-Type', 'image/webp');
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'File stiker tidak ditemukan.' });
    }
  });

  app.get('/api/created-stickers/:id/ogg', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^stk_[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const fullPath = path.join(SOUNDS_DIR, `${id}.ogg`);
    try {
      await fs.access(fullPath);
      res.setHeader('Content-Type', 'audio/ogg');
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'File audio tidak ditemukan.' });
    }
  });

  app.delete('/api/created-stickers/:id', async (req, res) => {
    const ok = await removeCreatedSticker(String(req.params.id || ''));
    if (!ok) return res.status(404).json({ error: 'Stiker tidak ditemukan.' });
    res.json({ deleted: true });
  });

  // Konversi video -> sound sticker (mendukung opsional ganti suara dengan audio upload / rekaman mikrofon)
  app.post(
    '/api/sound-sticker',
    upload.fields([
      { name: 'video', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const videoFile = req.files?.video?.[0];
        const customAudioFile = req.files?.audio?.[0];

        if (!videoFile?.buffer?.length) {
          return res.status(400).json({ error: 'Unggah file video MP4/MOV terlebih dahulu.' });
        }

        const targetMode = String(req.body?.targetMode || 'preview').trim();
        const targetPhone = formatIndonesianPhone(req.body?.phone);
        const requestedSessionId = String(req.body?.sessionId || '').trim();

        // Jika pengguna melampirkan audio kustom / rekaman suara, gabungkan ke video terlebih dahulu
        let sourceVideoBuffer = videoFile.buffer;
        if (customAudioFile?.buffer?.length) {
          const ext = guessAudioExtFromMime(customAudioFile.mimetype, customAudioFile.originalname);
          sourceVideoBuffer = await mergeVideoWithCustomAudio(
            videoFile.buffer,
            customAudioFile.buffer,
            ext
          );
        }

        const converted = await convertVideoToSoundSticker(sourceVideoBuffer, {
          ffmpegPath,
          ffprobePath,
        });

        let sentTo = null;
        if (targetMode === 'self' || targetMode === 'phone') {
          const activeSession =
            (requestedSessionId && sessions.get(requestedSessionId)) ||
            [...sessions.values()].find((s) => s.status === 'open' && s.sock?.user?.id);

          if (!activeSession || activeSession.status !== 'open' || !activeSession.sock?.user?.id) {
            return res.status(400).json({
              error: 'Belum ada nomor WhatsApp yang terhubung. Pairing nomor terlebih dahulu.',
            });
          }

          let targetJid = '';
          if (targetMode === 'self') {
            targetJid = `${normalizeUser(activeSession.sock.user.id)}@s.whatsapp.net`;
          } else {
            if (targetPhone.length < 10 || targetPhone.length > 16) {
              return res.status(400).json({
                error: 'Masukkan nomor WhatsApp tujuan yang valid (10–16 digit).',
              });
            }
            targetJid = `${targetPhone}@s.whatsapp.net`;
          }

          await sendVideoAsSoundSticker(activeSession.sock, targetJid, sourceVideoBuffer, {
            ffmpegPath,
            ffprobePath,
          });
          sentTo = normalizeUser(targetJid);
          pushLog(
            `🌐 [${activeSession.name}] Sound sticker${customAudioFile ? ' (suara kustom)' : ''} dikirim ke ${sentTo}`
          );
        } else {
          pushLog(`🌐 Sound sticker${customAudioFile ? ' (suara kustom)' : ''} dibuat di Web Studio`);
        }

        const archived = await archiveCreatedSticker({
          stickerBuffer: converted.sticker,
          audioBuffer: converted.audio,
          seconds: converted.seconds,
          source: customAudioFile
            ? sentTo
              ? `Kustom → ${sentTo}`
              : 'Web Kustom'
            : sentTo
              ? `Web → ${sentTo}`
              : 'Web',
          name: videoFile.originalname?.replace(/\.[^.]+$/, '') || undefined,
        });

        res.json({
          ok: true,
          sentTo,
          sticker: archived,
        });
      } catch (err) {
        res.status(400).json({ error: err?.message || 'Gagal mengonversi video.' });
      }
    }
  );

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload gagal: ${err.message}` });
    }
    res.status(500).json({ error: err?.message || 'Terjadi kesalahan server.' });
  });

  const server = app.listen(WEB_PORT, WEB_HOST, () => {
    const lanUrls = getLanAddresses(WEB_PORT);
    console.log('🌐 Aplikasi Web (PWA · Multi-Nomor Pairing HP) aktif di:');
    console.log(`   • Lokal : http://localhost:${WEB_PORT}`);
    for (const url of lanUrls) {
      console.log(`   • Wi-Fi / LAN : ${url}`);
    }
    console.log(
      `   • Publik (Internet): cloudflared tunnel --url http://localhost:${WEB_PORT}\n`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `❌ Port ${WEB_PORT} sudah dipakai oleh proses lain! Tutup jendela bot lama atau jalankan dengan PORT lain.`
      );
      process.exit(1);
    }
    console.error('❌ Error Web App:', err.message);
  });

  return server;
}

process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection:', err?.message || err);
});

printStartupBanner();
await loadCreatedStickers();
startWebApp();
initSessions().catch((err) => {
  console.error('❌ Gagal menginisialisasi sesi bot:', err);
  process.exit(1);
});
