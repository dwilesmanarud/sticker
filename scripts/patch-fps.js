import fs from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve('node_modules/@xbibzlibrary/whatsbibz/lib/Utils/sound-sticker.js');

const CLEAN_LOOP = `    let sticker;
    const presets = selectedDuration <= 5
      ? [[24, 72], [20, 62], [15, 55], [12, 48], [10, 40], [8, 30]]
      : selectedDuration <= 9
        ? [[15, 60], [12, 52], [10, 45], [8, 38], [6, 28], [5, 20]]
        : [[12, 55], [10, 48], [8, 42], [6, 35], [5, 25], [5, 18]];
    for (const [fps, quality] of presets) {
      const filter = \`fps=\${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p\`;
      await run(ffmpeg, [...common, '-map', '0:v:0', '-an', '-vf', filter, '-c:v', 'libwebp_anim', '-preset', 'default', '-q:v', String(quality),
        '-loop', '0', '-compression_level', '4', '-y', webpPath], timeoutMs);
      const size = (await stat(webpPath)).size;
      if (size <= SOUND_STICKER_MAX_WEBP_BYTES) {
        sticker = await readFile(webpPath);
        break;
      }
    }`;

try {
  let src = await fs.readFile(target, 'utf8');
  let changed = false;

  // 1. Batas ukuran WebP standar WhatsApp: 500 KiB (di atas 500 KiB WhatsApp HP menolak/menampilkan stiker warna-warni)
  if (/export const SOUND_STICKER_MAX_WEBP_BYTES = (?!500 \* 1024;)/.test(src)) {
    src = src.replace(
      /export const SOUND_STICKER_MAX_WEBP_BYTES = [^;]+;/,
      'export const SOUND_STICKER_MAX_WEBP_BYTES = 500 * 1024;'
    );
    changed = true;
  }

  // 2. Batas durasi maksimal: 15 detik
  if (/export const SOUND_STICKER_MAX_SECONDS = (?!15;)/.test(src)) {
    src = src.replace(
      /export const SOUND_STICKER_MAX_SECONDS = \d+;/,
      'export const SOUND_STICKER_MAX_SECONDS = 15;'
    );
    changed = true;
  }

  // 3. Batas ukuran audio: 256 KiB agar cukup untuk durasi hingga 15 detik
  if (/const MAX_AUDIO_BYTES = (?!256 \* 1024;)/.test(src)) {
    src = src.replace(
      /const MAX_AUDIO_BYTES = [^;]+;/,
      'const MAX_AUDIO_BYTES = 256 * 1024;'
    );
    changed = true;
  }

  // 4. Timeout FFmpeg 60 detik agar video 15 detik tidak timeout di VPS ringan
  if (/const DEFAULT_TIMEOUT_MS = (?!60_000;)/.test(src)) {
    src = src.replace(
      /const DEFAULT_TIMEOUT_MS = [^;]+;/,
      'const DEFAULT_TIMEOUT_MS = 60_000;'
    );
    changed = true;
  }

  // 5. Tambahkan -avoid_negative_ts make_zero pada encode audio OGG Opus agar aman untuk video TikTok/IG
  if (!src.includes("'-avoid_negative_ts', 'make_zero'")) {
    src = src.replace(
      "'-f', 'ogg', '-y', audioPath",
      "'-avoid_negative_ts', 'make_zero', '-f', 'ogg', '-y', audioPath"
    );
    changed = true;
  }

  // 6. Filter WebP bersih (yuva420p + -preset default, kualitas tinggi anti bergaris-garis, cepat <= 500 KiB)
  const loopRegex = /    let sticker;\r?\n(?:    const presets[\s\S]*?)?    for \(const \[[^\]]+\] of [\s\S]*?\r?\n    \}(?=\r?\n    if \(!sticker\))/;
  if (loopRegex.test(src) && !src.includes("format=yuva420p")) {
    src = src.replace(loopRegex, CLEAN_LOOP);
    changed = true;
  }

  // 7. Selaraskan pesan error WebP dengan batas 500 KiB
  if (/Could not fit the animated sticker into (?!500)\d+ KiB\./.test(src)) {
    src = src.replace(
      /Could not fit the animated sticker into \d+ KiB\./,
      'Could not fit the animated sticker into 500 KiB.'
    );
    changed = true;
  }

  if (changed) {
    await fs.writeFile(target, src, 'utf8');
    console.log('✅ Patched sound-sticker.js (24 FPS, filter bersih anti-glitch, maks. 15 detik, WebP 500 KiB, avoid_negative_ts)');
  } else {
    console.log('ℹ️ Patch sound-sticker.js (24 FPS, filter bersih anti-glitch, maks. 15 detik, WebP 500 KiB) sudah aktif');
  }
} catch (err) {
  console.warn('⚠️ Lewati patch sound-sticker.js:', err.message);
}
