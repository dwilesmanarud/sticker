import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { DEFAULT_SESSION_FEATURES, PATHS } from './config.js';
import { getFfmpegSource } from './audio.js';
import { getTotalStickers, listStickers } from './database.js';
import { handleIncomingMessage } from './handler.js';

const createSocket = makeWASocket.default ?? makeWASocket;
const SESSION_ID_REGEX = /^[a-z0-9_-]{2,32}$/;

const logger = pino({
  level: process.env.LOG_LEVEL || 'silent',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePrefix(prefix) {
  const clean = String(prefix || '.').trim().slice(0, 3);
  return clean || '.';
}

function sanitizeFeatures(features = {}) {
  return {
    stickerMaker: features.stickerMaker !== false,
    autoVideoSticker: features.autoVideoSticker !== false,
    soundSticker: features.soundSticker !== false,
    videoNote: features.videoNote !== false,
    stickerToImage: features.stickerToImage !== false,
  };
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
    this.writeQueue = Promise.resolve();
    this.cachedWaVersion = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, payload) {
    for (const listener of this.listeners) {
      listener(event, payload);
    }
  }

  async resolveWhatsAppVersion() {
    if (this.cachedWaVersion) return this.cachedWaVersion;
    try {
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`📱 Menggunakan WhatsApp Web v${version.join('.')} (terbaru: ${isLatest})`);
      this.cachedWaVersion = version;
      return version;
    } catch (err) {
      console.warn(`⚠️ Gagal mengambil versi WhatsApp terbaru (${err.message}), memakai versi bawaan.`);
      return undefined;
    }
  }

  async loadRegistry() {
    await fs.mkdir(PATHS.databaseDir, { recursive: true });
    try {
      const raw = await fs.readFile(PATHS.sessionsFile, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveRegistry() {
    const data = {};
    for (const [id, rec] of this.sessions.entries()) {
      data[id] = {
        id: rec.id,
        name: rec.name,
        prefix: rec.prefix,
        features: rec.features,
        createdAt: rec.createdAt,
      };
    }
    const snapshot = JSON.stringify(data, null, 2) + '\n';
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(PATHS.databaseDir, { recursive: true });
      const tmp = `${PATHS.sessionsFile}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, PATHS.sessionsFile);
    });
    return this.writeQueue;
  }

  getAuthDir(sessionId) {
    return path.join(PATHS.authSession, sessionId);
  }

  serializeSession(rec) {
    return {
      id: rec.id,
      name: rec.name,
      prefix: rec.prefix,
      features: { ...rec.features },
      createdAt: rec.createdAt,
      status: rec.status,
      qrDataUrl: rec.qrDataUrl,
      user: rec.user,
      canPair: Boolean(rec.sock && !rec.registered && rec.status !== 'open'),
    };
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      .map((rec) => this.serializeSession(rec));
  }

  async getOverview() {
    const sessions = this.listSessions();
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === 'open').length,
      totalStickers: await getTotalStickers(),
      ffmpegSource: getFfmpegSource(),
      sessions,
    };
  }

  async notifySessionsChanged() {
    this.emit('sessions', await this.getOverview());
  }

  async notifyStickersChanged() {
    this.emit('stickers', {
      stickers: await listStickers(),
      totalStickers: await getTotalStickers(),
    });
    this.emit('sessions', await this.getOverview());
  }

  async init({ autoConnect = true } = {}) {
    await fs.mkdir(PATHS.authSession, { recursive: true });
    const registry = await this.loadRegistry();
    const entries = Object.values(registry);

    if (entries.length === 0) {
      // Buat sesi default pertama agar langsung siap scan QR
      const defaultRec = {
        id: 'utama',
        name: 'Bot Utama',
        prefix: '.',
        features: { ...DEFAULT_SESSION_FEATURES },
        createdAt: new Date().toISOString(),
        status: 'connecting',
        qrDataUrl: null,
        user: null,
        registered: false,
        sock: null,
        reconnectTimer: null,
        isResetting: false,
        isDeleted: false,
      };
      this.sessions.set(defaultRec.id, defaultRec);
      await this.saveRegistry();
    } else {
      for (const item of entries) {
        if (!item?.id || !SESSION_ID_REGEX.test(item.id)) continue;
        this.sessions.set(item.id, {
          id: item.id,
          name: String(item.name || item.id).slice(0, 40),
          prefix: sanitizePrefix(item.prefix),
          features: sanitizeFeatures(item.features),
          createdAt: item.createdAt || new Date().toISOString(),
          status: 'connecting',
          qrDataUrl: null,
          user: null,
          registered: false,
          sock: null,
          reconnectTimer: null,
          isResetting: false,
          isDeleted: false,
        });
      }
    }

    if (autoConnect) {
      for (const rec of this.sessions.values()) {
        this.connectSession(rec.id).catch((err) => {
          console.error(`⚠️ Gagal menyambungkan sesi ${rec.id}:`, err.message);
        });
      }
    }
  }

  async createSession({ name, prefix = '.', features = {} } = {}) {
    if (this.sessions.size >= 10) {
      throw new Error('Maksimal 10 sesi bot aktif bersamaan pada 1 server.');
    }

    const cleanName = String(name || '').trim().slice(0, 40) || `Bot #${this.sessions.size + 1}`;
    const id = `bot_${crypto.randomBytes(3).toString('hex')}`;

    const rec = {
      id,
      name: cleanName,
      prefix: sanitizePrefix(prefix),
      features: sanitizeFeatures(features),
      createdAt: new Date().toISOString(),
      status: 'connecting',
      qrDataUrl: null,
      user: null,
      registered: false,
      sock: null,
      reconnectTimer: null,
      isResetting: false,
      isDeleted: false,
    };

    this.sessions.set(id, rec);
    await this.saveRegistry();
    await this.notifySessionsChanged();

    this.connectSession(id).catch((err) => {
      console.error(`⚠️ Gagal menyambungkan sesi baru ${id}:`, err.message);
    });

    return this.serializeSession(rec);
  }

  async updateSession(sessionId, { name, prefix, features } = {}) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error('Sesi bot tidak ditemukan.');

    if (name !== undefined) {
      const trimmed = String(name).trim().slice(0, 40);
      if (trimmed) rec.name = trimmed;
    }
    if (prefix !== undefined) {
      rec.prefix = sanitizePrefix(prefix);
    }
    if (features && typeof features === 'object') {
      rec.features = sanitizeFeatures({ ...rec.features, ...features });
    }

    await this.saveRegistry();
    await this.notifySessionsChanged();
    return this.serializeSession(rec);
  }

  async requestPairingCode(sessionId, phone) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error('Sesi bot tidak ditemukan.');
    if (!rec.sock || rec.status === 'open' || rec.registered) {
      throw new Error('Pairing code hanya tersedia saat sesi belum terhubung.');
    }

    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 16) {
      throw new Error('Masukkan nomor WhatsApp format internasional tanpa +, misal 6281234567890.');
    }

    const rawCode = await rec.sock.requestPairingCode(cleanPhone);
    return rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
  }

  async clearSessionAuthDir(sessionId) {
    const dir = this.getAuthDir(sessionId);
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
    await fs.mkdir(dir, { recursive: true });
  }

  async stopSocket(rec, shouldLogout = false) {
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
          // Abaikan jika timeout/error
        }
      }
      try {
        sockToClose.end(undefined);
      } catch {
        // Abaikan jika sudah tertutup
      }
      await sleep(300);
    }
  }

  async resetSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error('Sesi bot tidak ditemukan.');
    if (rec.isResetting) return this.serializeSession(rec);

    rec.isResetting = true;
    try {
      rec.status = 'connecting';
      rec.qrDataUrl = null;
      rec.user = null;
      rec.registered = false;
      await this.notifySessionsChanged();

      console.log(`🔄 [${rec.id}] Melepas pairing & menyiapkan QR Code baru...`);
      await this.stopSocket(rec, true);
      await this.clearSessionAuthDir(rec.id);
    } finally {
      rec.isResetting = false;
    }

    if (!rec.isDeleted) {
      await this.connectSession(rec.id);
    }
    return this.serializeSession(rec);
  }

  async deleteSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error('Sesi bot tidak ditemukan.');

    rec.isDeleted = true;
    rec.isResetting = true;
    await this.stopSocket(rec, true);

    const dir = this.getAuthDir(sessionId);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});

    this.sessions.delete(sessionId);
    await this.saveRegistry();
    await this.notifySessionsChanged();
    return { deleted: true, id: sessionId };
  }

  async connectSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.isDeleted) return;

    if (rec.reconnectTimer) {
      clearTimeout(rec.reconnectTimer);
      rec.reconnectTimer = null;
    }

    const authDir = this.getAuthDir(sessionId);
    await fs.mkdir(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const version = await this.resolveWhatsAppVersion();

    const sock = createSocket({
      ...(version ? { version } : {}),
      logger,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
    });

    rec.sock = sock;
    rec.registered = Boolean(state.creds.registered);
    rec.status = 'connecting';
    await this.notifySessionsChanged();

    sock.ev.on('creds.update', async () => {
      if (rec.isResetting || rec.isDeleted || rec.sock !== sock) return;
      try {
        await saveCreds();
      } catch {
        // Abaikan jika folder sedang dibersihkan
      }
    });

    sock.ev.on('connection.update', async (update) => {
      if (rec.sock !== sock || rec.isResetting || rec.isDeleted) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        rec.status = 'qr';
        rec.user = null;
        rec.registered = false;
        rec.qrDataUrl = await QRCode.toDataURL(qr, {
          width: 260,
          margin: 2,
          color: { dark: '#0f172a', light: '#ffffff' },
        });
        await this.notifySessionsChanged();

        if (rec.id === 'utama') {
          console.log(`\n📷 [${rec.name}] Scan QR Code berikut (atau scan di Web UI):\n`);
          qrcodeTerminal.generate(qr, { small: true });
        } else {
          console.log(`📷 [${rec.name}] QR Code siap di Web UI.`);
        }
      }

      if (connection === 'open') {
        rec.status = 'open';
        rec.qrDataUrl = null;
        rec.registered = true;
        rec.user = {
          id: sock.user?.id || null,
          name: sock.user?.name || 'Terhubung',
        };
        await this.notifySessionsChanged();
        console.log(`✅ [${rec.name}] Berhasil terhubung (${rec.user.name})!`);
      }

      if (connection === 'close') {
        rec.status = 'close';
        rec.qrDataUrl = null;
        rec.user = null;
        await this.notifySessionsChanged();

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          console.log(`⚠️ [${rec.name}] Sesi logout (401). Otomatis membuat QR Code baru...`);
          rec.reconnectTimer = setTimeout(() => {
            this.resetSession(rec.id).catch((err) =>
              console.error(`Gagal reset sesi ${rec.id}:`, err.message)
            );
          }, 1500);
          return;
        }

        console.log(`⚠️ [${rec.name}] Terputus (kode: ${statusCode ?? 'unknown'}). Reconnect 3 dtk...`);
        rec.reconnectTimer = setTimeout(() => {
          this.connectSession(rec.id).catch((err) =>
            console.error(`Gagal reconnect ${rec.id}:`, err.message)
          );
        }, 3000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || rec.sock !== sock || rec.isDeleted) return;

      for (const msg of messages) {
        await handleIncomingMessage(sock, msg, logger, {
          sessionConfig: {
            id: rec.id,
            name: rec.name,
            prefix: rec.prefix,
            features: rec.features,
          },
          onStickersChanged: () => this.notifyStickersChanged(),
        });
      }
    });
  }
}
