import fs from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from './config.js';

let cache = null;
let writeQueue = Promise.resolve();

async function ensureDatabaseFile() {
  await fs.mkdir(PATHS.databaseDir, { recursive: true });
  try {
    await fs.access(PATHS.databaseFile);
  } catch {
    await fs.writeFile(PATHS.databaseFile, '{}\n', 'utf8');
  }
}

export async function initDatabase() {
  await ensureDatabaseFile();
  const raw = await fs.readFile(PATHS.databaseFile, 'utf8');
  try {
    const parsed = JSON.parse(raw || '{}');
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Jika file JSON rusak, cadangkan lalu mulai ulang dengan objek kosong
    const backupPath = `${PATHS.databaseFile}.corrupt.${Date.now()}`;
    await fs.copyFile(PATHS.databaseFile, backupPath);
    cache = {};
    await persistDatabase();
  }
  return cache;
}

async function getStore() {
  if (!cache) {
    await initDatabase();
  }
  return cache;
}

function persistDatabase() {
  const snapshot = JSON.stringify(cache ?? {}, null, 2) + '\n';
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(PATHS.databaseDir, { recursive: true });
    const tempPath = `${PATHS.databaseFile}.tmp`;
    await fs.writeFile(tempPath, snapshot, 'utf8');
    await fs.rename(tempPath, PATHS.databaseFile);
  });
  return writeQueue;
}

export async function getSticker(hash) {
  const store = await getStore();
  return store[hash] ?? null;
}

export async function listStickers() {
  const store = await getStore();
  return Object.values(store).sort((a, b) =>
    (b.createdAt || '').localeCompare(a.createdAt || '')
  );
}

export async function setSticker(hash, metadata) {
  const store = await getStore();
  store[hash] = {
    hash,
    ...metadata,
  };
  await persistDatabase();
  return store[hash];
}

export async function deleteSticker(hash) {
  const store = await getStore();
  const existing = store[hash] ?? null;
  if (!existing) {
    return null;
  }
  delete store[hash];
  await persistDatabase();
  return existing;
}

export async function getTotalStickers() {
  const store = await getStore();
  return Object.keys(store).length;
}

export function resolveAudioFullPath(audioPath) {
  if (!audioPath) return null;
  return path.isAbsolute(audioPath) ? audioPath : path.resolve(PATHS.root, audioPath);
}
