import fs from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve('node_modules/@xbibzlibrary/whatsbibz/lib/Utils/sound-sticker.js');

try {
  let src = await fs.readFile(target, 'utf8');
  let changed = false;

  // 1. Patch batas ukuran hasil WebP: 1000 KiB (~1 MB)
  if (/export const SOUND_STICKER_MAX_WEBP_BYTES = (?!1000 \* 1024;)/.test(src)) {
    src = src.replace(
      /export const SOUND_STICKER_MAX_WEBP_BYTES = [^;]+;/,
      'export const SOUND_STICKER_MAX_WEBP_BYTES = 1000 * 1024;'
    );
    changed = true;
  }

  // 2. Patch durasi maksimal: 15 detik
  if (/export const SOUND_STICKER_MAX_SECONDS = (?!15;)/.test(src)) {
    src = src.replace(
      /export const SOUND_STICKER_MAX_SECONDS = \d+;/,
      'export const SOUND_STICKER_MAX_SECONDS = 15;'
    );
    changed = true;
  }

  // 3. Patch batas ukuran audio: 256 KiB agar aman untuk durasi hingga 15 detik
  if (/const MAX_AUDIO_BYTES = (?!256 \* 1024;)/.test(src)) {
    src = src.replace(
      /const MAX_AUDIO_BYTES = [^;]+;/,
      'const MAX_AUDIO_BYTES = 256 * 1024;'
    );
    changed = true;
  }

  // 4. Patch preset FPS & kualitas (24 FPS + fallback kompresi lebih ringan)
  const desiredPresets = '[[24, 70], [24, 55], [15, 45], [10, 35], [8, 25], [6, 15], [5, 10]]';
  const presetRegex = /\[\[(?:12|24), 70\], \[(?:12|24), 55\], \[10, 42\], \[8, 30\], \[6, 20\]\]/;
  if (presetRegex.test(src)) {
    src = src.replace(presetRegex, desiredPresets);
    changed = true;
  }

  // 5. Selaraskan pesan error WebP dengan batas 1000 KiB
  if (src.includes('Could not fit the animated sticker into 500 KiB.')) {
    src = src.replace(
      'Could not fit the animated sticker into 500 KiB.',
      'Could not fit the animated sticker into 1000 KiB.'
    );
    changed = true;
  }

  if (changed) {
    await fs.writeFile(target, src, 'utf8');
    console.log('✅ Patched sound-sticker.js (24 FPS, maks. 15 detik, WebP 1000 KiB, audio 256 KiB)');
  } else {
    console.log('ℹ️ Patch sound-sticker.js (24 FPS, maks. 15 detik, 1000 KiB) sudah aktif');
  }
} catch (err) {
  console.warn('⚠️ Lewati patch sound-sticker.js:', err.message);
}
