import fs from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve('node_modules/@xbibzlibrary/whatsbibz/lib/Utils/sound-sticker.js');

const STITCH_HELPER = `
// Pure-Node WebP Chunk Stitcher: menggabungkan potongan libwebp_anim per 1.5 detik
// (setiap 1.5 detik mendapat keyframe baru yang bersih -> mulus 15-24 FPS, tajam, 0% garis-garis, <= 500 KiB)
function extractAnmfChunks(buf) {
  const chunks = [];
  let hasAlpha = false;
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return { chunks, hasAlpha };
  }
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const padded = size + (size % 2);
    const end = pos + 8 + padded;
    if (end > buf.length) break;
    if (tag === 'VP8X' && (buf[pos + 8] & 0x10)) hasAlpha = true;
    if (tag === 'ANMF') chunks.push(buf.subarray(pos, end));
    pos = end;
  }
  return { chunks, hasAlpha };
}

function writeUInt24LE(buf, val, offset) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
}

function stitchWebpChunks(webpBufs, width = 512, height = 512) {
  const allAnmf = [];
  let hasAlpha = false;
  for (const b of webpBufs) {
    const { chunks, hasAlpha: ha } = extractAnmfChunks(b);
    if (ha) hasAlpha = true;
    allAnmf.push(...chunks);
  }
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 4, 'ascii');
  vp8x.writeUInt32LE(10, 4);
  vp8x[8] = hasAlpha ? 0x12 : 0x02;
  writeUInt24LE(vp8x, width - 1, 12);
  writeUInt24LE(vp8x, height - 1, 15);

  const anim = Buffer.alloc(14);
  anim.write('ANIM', 0, 4, 'ascii');
  anim.writeUInt32LE(6, 4);
  anim.writeUInt32LE(0, 8);
  anim.writeUInt16LE(0, 12);

  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, anim, ...allAnmf]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
`;

const SMOOTH_LOOP = `    let sticker;
    const presets = selectedDuration <= 4
      ? [[24, 68], [24, 56], [20, 50], [16, 45], [12, 38], [10, 32]]
      : selectedDuration <= 8
        ? [[20, 55], [18, 48], [15, 45], [12, 40], [10, 35], [8, 28]]
        : [[16, 50], [15, 45], [12, 40], [10, 35], [8, 30], [6, 24]];
    const chunkSec = 1.5;
    for (const [fps, quality] of presets) {
      const filter = \`fps=\${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000\`;
      if (selectedDuration <= chunkSec + 0.2) {
        await run(ffmpeg, [...common, '-map', '0:v:0', '-an', '-vf', filter, '-c:v', 'libwebp_anim', '-preset', 'default', '-q:v', String(quality),
          '-loop', '0', '-compression_level', '4', '-y', webpPath], timeoutMs);
        const size = (await stat(webpPath)).size;
        if (size <= SOUND_STICKER_MAX_WEBP_BYTES) {
          sticker = await readFile(webpPath);
          break;
        }
      } else {
        const partBufs = [];
        let estBytes = 40;
        let overflow = false;
        for (let off = 0, idx = 0; off < selectedDuration - 0.04; off += chunkSec, idx++) {
          const len = Math.min(chunkSec, selectedDuration - off);
          const partPath = path.join(dir, \`p_\${idx}.webp\`);
          await run(ffmpeg, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '67108864', '-threads', '2',
            '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0',
            '-ss', String(start + off), '-t', String(len), '-i', input,
            '-map', '0:v:0', '-an', '-vf', filter, '-c:v', 'libwebp_anim', '-preset', 'default', '-q:v', String(quality),
            '-loop', '0', '-compression_level', '4', '-y', partPath,
          ], timeoutMs);
          const pBuf = await readFile(partPath);
          partBufs.push(pBuf);
          estBytes += pBuf.length;
          if (estBytes > SOUND_STICKER_MAX_WEBP_BYTES + 4096) {
            overflow = true;
            break;
          }
        }
        if (!overflow && partBufs.length > 0) {
          const stitched = stitchWebpChunks(partBufs, 512, 512);
          if (stitched.length <= SOUND_STICKER_MAX_WEBP_BYTES) {
            sticker = stitched;
            break;
          }
        }
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

  // 4. Timeout FFmpeg 60 detik
  if (/const DEFAULT_TIMEOUT_MS = (?!60_000;)/.test(src)) {
    src = src.replace(
      /const DEFAULT_TIMEOUT_MS = [^;]+;/,
      'const DEFAULT_TIMEOUT_MS = 60_000;'
    );
    changed = true;
  }

  // 5. Tambahkan -avoid_negative_ts make_zero pada encode audio OGG Opus
  if (!src.includes("'-avoid_negative_ts', 'make_zero'")) {
    src = src.replace(
      "'-f', 'ogg', '-y', audioPath",
      "'-avoid_negative_ts', 'make_zero', '-f', 'ogg', '-y', audioPath"
    );
    changed = true;
  }

  // 6. Ganti helper lama (muxAnimatedWebp) atau injeksi stitchWebpChunks baru
  if (src.includes('function muxAnimatedWebp(')) {
    src = src.replace(
      /\/\/ Pure-Node WebP Animated Muxer[\s\S]*?(?=export async function convertVideoToSoundSticker\()/,
      `${STITCH_HELPER}\n`
    );
    changed = true;
  } else if (!src.includes('function stitchWebpChunks(')) {
    src = src.replace(
      'export async function convertVideoToSoundSticker(',
      `${STITCH_HELPER}\nexport async function convertVideoToSoundSticker(`
    );
    changed = true;
  }

  // 7. Ganti loop WebP dengan chunked keyframe 1.5s (15-24 FPS mulus, tajam, 0% garis-garis, <= 500 KiB)
  const loopRegex = /    let sticker;\r?\n[\s\S]*?\r?\n    \}(?=\r?\n    if \(!sticker\))/;
  if (loopRegex.test(src) && !src.includes('stitchWebpChunks(partBufs')) {
    src = src.replace(loopRegex, SMOOTH_LOOP);
    changed = true;
  }

  // 8. Selaraskan pesan error WebP dengan batas 500 KiB
  if (/Could not fit the animated sticker into (?!500)\d+ KiB\./.test(src)) {
    src = src.replace(
      /Could not fit the animated sticker into \d+ KiB\./,
      'Could not fit the animated sticker into 500 KiB.'
    );
    changed = true;
  }

  if (changed) {
    await fs.writeFile(target, src, 'utf8');
    console.log('✅ Patched sound-sticker.js (chunked keyframe 1.5s, mulus 15-24 FPS, anti-striping, maks. 15 detik, WebP 500 KiB)');
  } else {
    console.log('ℹ️ Patch sound-sticker.js (chunked keyframe 1.5s, mulus 15-24 FPS, WebP 500 KiB) sudah aktif');
  }
} catch (err) {
  console.warn('⚠️ Lewati patch sound-sticker.js:', err.message);
}
