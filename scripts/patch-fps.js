import fs from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve('node_modules/@xbibzlibrary/whatsbibz/lib/Utils/sound-sticker.js');

const OPTIMIZED_LOOP = `    let sticker;
    for (const [fps, quality, scaleSize] of [[24, 72, 512], [24, 58, 512], [20, 50, 512], [16, 45, 512], [15, 42, 384], [12, 36, 384], [10, 32, 320], [8, 24, 320], [6, 16, 256]]) {
      const denoise = scaleSize >= 512 ? 'hqdn3d=1.2:1.2:5:5' : 'hqdn3d=1.5:1.5:6:6';
      const scaleChain = scaleSize >= 512
        ? 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,unsharp=3:3:0.3:3:3:0.0'
        : \`scale=\${scaleSize}:\${scaleSize}:force_original_aspect_ratio=decrease:flags=lanczos,scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos\`;
      const filter = \`fps=\${fps},\${denoise},\${scaleChain},format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000\`;
      await run(ffmpeg, [...common, '-map', '0:v:0', '-an', '-vf', filter, '-c:v', 'libwebp_anim', '-q:v', String(quality),
        '-loop', '0', '-compression_level', '5', '-y', webpPath], timeoutMs);
      const size = (await stat(webpPath)).size;
      if (size <= SOUND_STICKER_MAX_WEBP_BYTES) {
        sticker = await readFile(webpPath);
        break;
      }
    }`;

try {
  let src = await fs.readFile(target, 'utf8');
  let changed = false;

  // 1. Batas ukuran WebP standar WhatsApp: 500 KiB
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

  // 6. Optimasi loop encode WebP: denoise ringan (hqdn3d) + unsharp + tangga FPS/resolusi pintar (tetap full 512x512 <= 500 KiB)
  const loopRegex = /    let sticker;\r?\n    for \(const \[[^\]]+\] of \[[\s\S]*?\r?\n    \}(?=\r?\n    if \(!sticker\))/;
  if (loopRegex.test(src) && !src.includes('hqdn3d=1.2:1.2:5:5')) {
    src = src.replace(loopRegex, OPTIMIZED_LOOP);
    changed = true;
  }

  // 7. Selaraskan pesan error WebP dengan batas 500 KiB
  if (src.includes('Could not fit the animated sticker into 1000 KiB.')) {
    src = src.replace(
      'Could not fit the animated sticker into 1000 KiB.',
      'Could not fit the animated sticker into 500 KiB.'
    );
    changed = true;
  }

  if (changed) {
    await fs.writeFile(target, src, 'utf8');
    console.log('✅ Patched sound-sticker.js (24 FPS, tajam+denoise, maks. 15 detik, WebP 500 KiB, avoid_negative_ts)');
  } else {
    console.log('ℹ️ Patch sound-sticker.js (24 FPS, tajam+denoise, maks. 15 detik, WebP 500 KiB) sudah aktif');
  }
} catch (err) {
  console.warn('⚠️ Lewati patch sound-sticker.js:', err.message);
}
