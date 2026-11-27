import fs from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve('node_modules/@xbibzlibrary/whatsbibz/lib/Utils/sound-sticker.js');

const MUX_HELPER = `
// Pure-Node WebP Animated Muxer (menggabungkan frame libwebp independen agar bebas bug garis-garis / striping libwebp_anim)
function extractWebpFramePayload(buf) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return { payload: Buffer.alloc(0), hasAlpha: false };
  }
  const parts = [];
  let hasAlpha = false;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const padded = size + (size % 2);
    const end = pos + 8 + padded;
    if (end > buf.length) break;
    if (tag === 'ALPH' || tag === 'VP8 ' || tag === 'VP8L') {
      if (tag === 'ALPH' || tag === 'VP8L') hasAlpha = true;
      parts.push(buf.subarray(pos, end));
    }
    pos = end;
  }
  return { payload: Buffer.concat(parts), hasAlpha };
}

function writeUInt24LE(buf, val, offset) {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
}

function muxAnimatedWebp(frameBuffers, fps, width = 512, height = 512) {
  const frameMs = Math.max(20, Math.round(1000 / fps));
  const anmfChunks = [];
  let hasAlpha = false;

  for (const fb of frameBuffers) {
    const { payload, hasAlpha: fAlpha } = extractWebpFramePayload(fb);
    if (!payload.length) continue;
    if (fAlpha) hasAlpha = true;
    const chunkSize = 16 + payload.length;
    const header = Buffer.alloc(24);
    header.write('ANMF', 0, 4, 'ascii');
    header.writeUInt32LE(chunkSize, 4);
    writeUInt24LE(header, 0, 8);
    writeUInt24LE(header, 0, 11);
    writeUInt24LE(header, width - 1, 14);
    writeUInt24LE(header, height - 1, 17);
    writeUInt24LE(header, frameMs, 20);
    header[23] = 0x02; // blend=1 (do not blend / replace full canvas), dispose=0
    anmfChunks.push(header, payload);
    if (chunkSize % 2 === 1) anmfChunks.push(Buffer.alloc(1));
  }

  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 4, 'ascii');
  vp8x.writeUInt32LE(10, 4);
  vp8x[8] = hasAlpha ? 0x12 : 0x02; // ANIM (+ ALPHA)
  writeUInt24LE(vp8x, width - 1, 12);
  writeUInt24LE(vp8x, height - 1, 15);

  const anim = Buffer.alloc(14);
  anim.write('ANIM', 0, 4, 'ascii');
  anim.writeUInt32LE(6, 4);
  anim.writeUInt32LE(0, 8);
  anim.writeUInt16LE(0, 12);

  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, anim, ...anmfChunks]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
`;

const CLEAN_LOOP = `    let sticker;
    const presets = selectedDuration <= 4
      ? [[24, 65], [20, 58], [15, 52], [12, 45], [10, 38], [8, 30]]
      : selectedDuration <= 8
        ? [[15, 55], [12, 48], [10, 42], [8, 36], [6, 28], [5, 22]]
        : [[10, 45], [8, 42], [8, 34], [6, 32], [6, 24], [5, 20]];
    const { readdir, mkdir } = await import('node:fs/promises');
    for (let pi = 0; pi < presets.length; pi++) {
      const [fps, quality] = presets[pi];
      const fDir = path.join(dir, \`f_\${pi}\`);
      await mkdir(fDir, { recursive: true });
      const filter = \`fps=\${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000\`;
      await run(ffmpeg, [...common, '-map', '0:v:0', '-an', '-vf', filter, '-c:v', 'libwebp', '-q:v', String(quality),
        '-compression_level', '4', '-y', path.join(fDir, 'f_%04d.webp')], timeoutMs);
      const frameFiles = (await readdir(fDir)).filter((f) => f.endsWith('.webp')).sort();
      if (frameFiles.length >= 2) {
        const frameBufs = await Promise.all(frameFiles.map((f) => readFile(path.join(fDir, f))));
        const muxed = muxAnimatedWebp(frameBufs, fps, 512, 512);
        if (muxed.length <= SOUND_STICKER_MAX_WEBP_BYTES) {
          sticker = muxed;
          break;
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

  // 6. Injeksi pure-Node WebP Animated Muxer jika belum ada
  if (!src.includes('function muxAnimatedWebp(')) {
    src = src.replace(
      'export async function convertVideoToSoundSticker(',
      `${MUX_HELPER}\nexport async function convertVideoToSoundSticker(`
    );
    changed = true;
  }

  // 7. Ganti loop libwebp_anim dengan frame independen libwebp + muxAnimatedWebp (0% garis-garis/striping!)
  const loopRegex = /    let sticker;\r?\n(?:    const presets[\s\S]*?)?    for \([\s\S]*?\r?\n    \}(?=\r?\n    if \(!sticker\))/;
  if (loopRegex.test(src) && !src.includes('muxAnimatedWebp(frameBufs')) {
    src = src.replace(loopRegex, CLEAN_LOOP);
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
    console.log('✅ Patched sound-sticker.js (frame independen libwebp + RIFF muxer anti-striping, maks. 15 detik, WebP 500 KiB)');
  } else {
    console.log('ℹ️ Patch sound-sticker.js (anti-striping, maks. 15 detik, WebP 500 KiB) sudah aktif');
  }
} catch (err) {
  console.warn('⚠️ Lewati patch sound-sticker.js:', err.message);
}
