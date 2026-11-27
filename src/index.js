import { initDatabase } from './database.js';
import { initSoundStickerStore } from './soundStickerStore.js';
import { getFfmpegSource } from './audio.js';
import { SessionManager } from './sessionManager.js';
import { startWebServer } from './web.js';

async function bootstrap() {
  process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled rejection:', err?.message || err);
  });
  process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught exception:', err?.message || err);
  });

  await initDatabase();
  await initSoundStickerStore();

  const ffmpegSource = getFfmpegSource();
  console.log(`🎬 Sumber ffmpeg: ${ffmpegSource}`);
  if (ffmpegSource === 'none') {
    console.warn(
      '⚠️ ffmpeg tidak ditemukan! Konversi media tidak akan berjalan sampai ffmpeg terpasang.'
    );
  }

  const sessionManager = new SessionManager();
  startWebServer(sessionManager);

  await sessionManager.init({ autoConnect: true });
}

bootstrap().catch((error) => {
  console.error('❌ Gagal menjalankan platform bot:', error);
  process.exit(1);
});
