import fs from 'node:fs/promises';
import { PATHS } from './config.js';

let storeCache = null;
let writeQueue = Promise.resolve();

/**
 * Mengonversi objek pesan Baileys (yang bisa berisi Buffer/Uint8Array/Long/BigInt)
 * menjadi JSON-safe agar bisa disimpan di database/sound_stickers.json dan dipulihkan kembali.
 */
export function serializeProtoPayload(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return { __type: 'BigInt', value: value.toString() };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __type: 'Uint8Array', data: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeProtoPayload(item));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'function') continue;
      out[k] = serializeProtoPayload(v);
    }
    return out;
  }
  return value;
}

/**
 * Memulihkan kembali Uint8Array / BigInt dari payload yang disimpan di JSON.
 */
export function deserializeProtoPayload(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => deserializeProtoPayload(item));
  }
  if (typeof value === 'object') {
    if (value.__type === 'Uint8Array' && typeof value.data === 'string') {
      return new Uint8Array(Buffer.from(value.data, 'base64'));
    }
    if (value.__type === 'BigInt' && typeof value.value === 'string') {
      return Number(value.value);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deserializeProtoPayload(v);
    }
    return out;
  }
  return value;
}

export function normalizeStickName(rawName) {
  return String(rawName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

async function ensureStoreFile() {
  await fs.mkdir(PATHS.databaseDir, { recursive: true });
  try {
    await fs.access(PATHS.soundStickersFile);
  } catch {
    const initial = { items: {}, relayChats: {} };
    await fs.writeFile(PATHS.soundStickersFile, JSON.stringify(initial, null, 2) + '\n', 'utf8');
  }
}

export async function initSoundStickerStore() {
  await ensureStoreFile();
  const raw = await fs.readFile(PATHS.soundStickersFile, 'utf8');
  try {
    const parsed = JSON.parse(raw || '{}');
    storeCache = {
      items: parsed?.items && typeof parsed.items === 'object' ? parsed.items : {},
      relayChats: parsed?.relayChats && typeof parsed.relayChats === 'object' ? parsed.relayChats : {},
    };
  } catch {
    const backup = `${PATHS.soundStickersFile}.corrupt.${Date.now()}`;
    await fs.copyFile(PATHS.soundStickersFile, backup).catch(() => {});
    storeCache = { items: {}, relayChats: {} };
    await persistStore();
  }
  return storeCache;
}

async function getStore() {
  if (!storeCache) {
    await initSoundStickerStore();
  }
  return storeCache;
}

function persistStore() {
  const snapshot = JSON.stringify(storeCache ?? { items: {}, relayChats: {} }, null, 2) + '\n';
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(PATHS.databaseDir, { recursive: true });
    const tmp = `${PATHS.soundStickersFile}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, PATHS.soundStickersFile);
  });
  return writeQueue;
}

export async function saveSoundSticker(name, entry) {
  const key = normalizeStickName(name);
  if (!key) throw new Error('Nama stiker tidak valid. Gunakan huruf, angka, _ atau -.');
  const store = await getStore();
  store.items[key] = {
    name: key,
    ...entry,
    rawMessage: entry.rawMessage ? serializeProtoPayload(entry.rawMessage) : null,
  };
  await persistStore();
  return store.items[key];
}

export async function getSoundSticker(name) {
  const key = normalizeStickName(name);
  if (!key) return null;
  const store = await getStore();
  const item = store.items[key];
  if (!item) return null;
  return {
    ...item,
    rawMessage: item.rawMessage ? deserializeProtoPayload(item.rawMessage) : null,
  };
}

export async function findSoundStickerByHash(hash) {
  if (!hash) return null;
  const store = await getStore();
  for (const item of Object.values(store.items)) {
    if (item.hash === hash) {
      return {
        ...item,
        rawMessage: item.rawMessage ? deserializeProtoPayload(item.rawMessage) : null,
      };
    }
  }
  return null;
}

export async function listSoundStickers() {
  const store = await getStore();
  return Object.values(store.items)
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))
    .map(({ rawMessage: _omit, ...summary }) => summary);
}

export async function setRelayChatEnabled(chatId, enabled) {
  const store = await getStore();
  store.relayChats[chatId] = Boolean(enabled);
  await persistStore();
  return store.relayChats[chatId];
}

export async function isRelayChatEnabled(chatId) {
  const store = await getStore();
  return Boolean(store.relayChats[chatId]);
}
