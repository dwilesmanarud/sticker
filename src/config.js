import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export const PATHS = {
  root: ROOT_DIR,
  authSession: path.join(ROOT_DIR, 'auth_session'),
  databaseDir: path.join(ROOT_DIR, 'database'),
  databaseFile: path.join(ROOT_DIR, 'database', 'stickers.json'),
  soundStickersFile: path.join(ROOT_DIR, 'database', 'sound_stickers.json'),
  sessionsFile: path.join(ROOT_DIR, 'database', 'sessions.json'),
  soundsDir: path.join(ROOT_DIR, 'sounds'),
  stickersDir: path.join(ROOT_DIR, 'stickers'),
  tempDir: path.join(ROOT_DIR, 'temp'),
  publicDir: path.join(ROOT_DIR, 'public'),
};

export const DEFAULT_SESSION_FEATURES = {
  stickerMaker: true,
  autoVideoSticker: true, // Aktif default: video singkat (<= 8 detik) dengan atau tanpa .stikersuara otomatis jadi stiker + VN
  soundSticker: true,
  videoNote: true,
  stickerToImage: true,
};

export const BOT_CONFIG = {
  prefix: '.',
  replyDelayMinMs: 350,
  replyDelayMaxMs: 700,
  pendingSessionTtlMs: 2 * 60 * 1000, // 2 menit untuk alur .setsuara 2 langkah
  maxStickerVideoSeconds: 8, // Batas maksimal durasi video untuk stiker animasi (detik)
  maxVideoSizeBytes: 15 * 1024 * 1024, // Batas maksimal ukuran video (15 MB)
};

export const WEB_CONFIG = {
  host: process.env.HOST || '0.0.0.0', // 0.0.0.0 agar bisa diakses dari perangkat lain di jaringan/publik
  port: Number(process.env.PORT || 3000),
  maxUploadBytes: 25 * 1024 * 1024, // Maksimal 25 MB (mendukung upload video)
};

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.opus',
  '.aac',
  '.flac',
  '.webm',
]);

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.m4v',
  '.3gp',
]);
