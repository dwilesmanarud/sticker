import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { BOT_CONFIG, PATHS } from './config.js';

let ffmpegSource = 'none';
let resolvedFfmpegBin = 'ffmpeg';

function configureFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegSource = 'system';
    resolvedFfmpegBin = 'ffmpeg';
    return;
  } catch {
    // System ffmpeg tidak ditemukan di PATH, coba fallback ke ffmpeg-static
  }

  if (typeof ffmpegStatic === 'string' && ffmpegStatic.length > 0) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
    ffmpegSource = 'ffmpeg-static';
    resolvedFfmpegBin = ffmpegStatic;
  }
}

configureFfmpeg();

export function getFfmpegSource() {
  return ffmpegSource;
}

function assertFfmpegAvailable() {
  if (ffmpegSource === 'none') {
    throw new Error(
      'ffmpeg tidak ditemukan di sistem maupun ffmpeg-static. Pastikan ffmpeg terpasang.'
    );
  }
}

export async function ensureTempDir() {
  await fs.mkdir(PATHS.tempDir, { recursive: true });
}

export async function cleanupTempFiles(filePaths = []) {
  await Promise.all(
    filePaths
      .filter(Boolean)
      .map((filePath) => fs.rm(filePath, { force: true }).catch(() => {}))
  );
}

/**
 * Menyimpan buffer video ke file sementara di folder temp/.
 */
export async function saveTempVideo(videoBuffer, inputExt = '.mp4') {
  await ensureTempDir();
  const safeExt = inputExt.startsWith('.') ? inputExt : `.${inputExt}`;
  const tempPath = path.join(PATHS.tempDir, `video-in-${crypto.randomUUID()}${safeExt}`);
  await fs.writeFile(tempPath, videoBuffer);
  return tempPath;
}

/**
 * Memeriksa durasi (detik) dan keberadaan trek audio pada file video
 * menggunakan output metadata `ffmpeg -i` (tanpa bergantung pada ffprobe terpisah).
 */
export function inspectVideoFile(videoPath) {
  assertFfmpegAvailable();
  return new Promise((resolve) => {
    execFile(resolvedFfmpegBin, ['-i', videoPath], (_err, _stdout, stderr = '') => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      let durationSeconds = null;
      if (durationMatch) {
        const hours = Number(durationMatch[1]);
        const mins = Number(durationMatch[2]);
        const secs = Number(durationMatch[3]);
        durationSeconds = Math.round((hours * 3600 + mins * 60 + secs) * 10) / 10;
      }
      const hasAudioStream = /Stream\s+#\d+:\d+.*:\s*Audio:/i.test(stderr);
      resolve({ durationSeconds, hasAudioStream });
    });
  });
}

/**
 * Tahap 1: Konversi file video di temp/ menjadi stiker animasi WebP 512x512
 * dengan rasio/padding transparan rapi dan FPS terkontrol agar ukuran kecil & valid di WhatsApp.
 */
export async function convertVideoFileToAnimatedWebp(tempVideoPath, outputWebpPath) {
  assertFfmpegAvailable();
  await ensureTempDir();

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .noAudio()
        .setDuration(BOT_CONFIG.maxStickerVideoSeconds)
        .videoCodec('libwebp')
        .outputOptions([
          '-vf',
          'fps=12,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
          '-loop',
          '0',
          '-preset',
          'default',
          '-q:v',
          '45',
          '-compression_level',
          '4',
          '-an',
          '-vsync',
          '0',
        ])
        .format('webp')
        .on('end', resolve)
        .on('error', reject)
        .save(outputWebpPath);
    });

    const webpBuffer = await fs.readFile(outputWebpPath);
    if (!webpBuffer.length) {
      throw new Error('Hasil konversi WebP kosong.');
    }
    return webpBuffer;
  } catch (err) {
    await fs.rm(outputWebpPath, { force: true }).catch(() => {});
    throw new Error(`Konversi stiker animasi WebP gagal: ${err.message}`);
  }
}

/**
 * Tahap 2: Ekstrak trek audio asli dari file video di temp/ ke format OGG Opus
 * menggunakan flag -c:a libopus -ac 1 -avoid_negative_ts make_zero agar siap dikirim
 * sebagai Voice Note (audio/ogg; codecs=opus, ptt: true).
 */
export async function extractAudioFileToOggOpus(tempVideoPath, outputOggPath) {
  assertFfmpegAvailable();
  await ensureTempDir();

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .noVideo()
        .outputOptions([
          '-c:a',
          'libopus',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-b:a',
          '64k',
          '-application',
          'voip',
          '-avoid_negative_ts',
          'make_zero',
        ])
        .format('ogg')
        .on('end', resolve)
        .on('error', reject)
        .save(outputOggPath);
    });

    const stat = await fs.stat(outputOggPath);
    if (!stat.size) {
      throw new Error('File audio OGG hasil ekstraksi kosong.');
    }
    return outputOggPath;
  } catch (err) {
    await fs.rm(outputOggPath, { force: true }).catch(() => {});
    throw new Error(`Ekstraksi audio ke OGG Opus gagal: ${err.message}`);
  }
}

/**
 * Mengunduh audio TTS (Text-to-Speech Bahasa Indonesia) dari teks singkat
 * lalu mengembalikan Buffer MP3 agar bisa dikonversi ke OGG Opus.
 */
export async function synthesizeTtsBuffer(text, lang = 'id') {
  const cleanText = String(text || '').trim().slice(0, 200);
  if (!cleanText) {
    throw new Error('Teks TTS tidak boleh kosong.');
  }

  const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(cleanText)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Layanan TTS gagal merespons (HTTP ${response.status}).`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length < 100) {
    throw new Error('Audio TTS yang diterima kosong.');
  }
  return buffer;
}

/**
 * Jalur 3 (.videostiker / .gifsuara):
 * Mengonversi video singkat menjadi klip MP4 bersuara (512x512, H.264 + AAC)
 * di folder temp/ agar visual gerak dan suara tampil dalam satu pesan.
 * Pemanggil wajib membersihkan path output di blok try/finally.
 */
export async function convertVideoFileToSquareClip(tempVideoPath, outputMp4Path) {
  assertFfmpegAvailable();
  await ensureTempDir();

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .setDuration(15)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .outputOptions([
          '-vf',
          'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black',
          '-pix_fmt',
          'yuv420p',
          '-profile:v',
          'baseline',
          '-level',
          '3.0',
          '-movflags',
          '+faststart',
          '-preset',
          'veryfast',
          '-crf',
          '26',
          '-avoid_negative_ts',
          'make_zero',
        ])
        .format('mp4')
        .on('end', resolve)
        .on('error', reject)
        .save(outputMp4Path);
    });

    const stat = await fs.stat(outputMp4Path);
    if (!stat.size) {
      throw new Error('Klip video hasil konversi kosong.');
    }
    return outputMp4Path;
  } catch (err) {
    await fs.rm(outputMp4Path, { force: true }).catch(() => {});
    throw new Error(`Konversi klip .videostiker gagal: ${err.message}`);
  }
}

/**
 * Mengonversi buffer audio (MP3, WAV, M4A, OGG/VN, dll.) ke OGG Opus
 * di folder sounds/ memakai file sementara di temp/.
 */
export async function convertToVoiceNote(inputBuffer, outputFileName, inputExt = '.bin') {
  assertFfmpegAvailable();
  await ensureTempDir();
  await fs.mkdir(PATHS.soundsDir, { recursive: true });

  const safeExt = inputExt.startsWith('.') ? inputExt : `.${inputExt}`;
  const tempInputPath = path.join(PATHS.tempDir, `audio-in-${crypto.randomUUID()}${safeExt}`);
  const fullPath = path.join(PATHS.soundsDir, outputFileName);
  const relativePath = path.posix.join('sounds', outputFileName);

  await fs.writeFile(tempInputPath, inputBuffer);

  try {
    await extractAudioFileToOggOpus(tempInputPath, fullPath);
    return {
      fullPath,
      relativePath,
      fileName: outputFileName,
    };
  } finally {
    await cleanupTempFiles([tempInputPath]);
  }
}

/**
 * Helper terpadu (dipakai Web UI & API) untuk mengonversi buffer video bersuara
 * menjadi stiker animasi (.webp) + suara OGG Opus (.ogg) dengan validasi durasi & pembersihan temp/.
 */
export async function convertVideoToSoundSticker(videoBuffer, inputExt = '.mp4') {
  assertFfmpegAvailable();
  if (videoBuffer.length > BOT_CONFIG.maxVideoSizeBytes) {
    const maxMb = Math.round(BOT_CONFIG.maxVideoSizeBytes / (1024 * 1024));
    throw new Error(`Ukuran video terlalu besar. Maksimal ${maxMb} MB.`);
  }

  await ensureTempDir();
  await fs.mkdir(PATHS.stickersDir, { recursive: true });
  await fs.mkdir(PATHS.soundsDir, { recursive: true });

  const tempId = crypto.randomUUID();
  const tempVideoPath = await saveTempVideo(videoBuffer, inputExt);
  const tempWebpPath = path.join(PATHS.tempDir, `sticker-out-${tempId}.webp`);
  const tempOggPath = path.join(PATHS.tempDir, `audio-out-${tempId}.ogg`);

  try {
    const meta = await inspectVideoFile(tempVideoPath);
    if (meta.durationSeconds !== null && meta.durationSeconds > BOT_CONFIG.maxStickerVideoSeconds) {
      throw new Error(
        `Durasi video terlalu panjang (${meta.durationSeconds} detik). Maksimal ${BOT_CONFIG.maxStickerVideoSeconds} detik.`
      );
    }

    const stickerBuffer = await convertVideoFileToAnimatedWebp(tempVideoPath, tempWebpPath);
    const hash = crypto.createHash('sha256').update(stickerBuffer).digest('hex');

    const stickerFileName = `${hash}.webp`;
    const stickerFullPath = path.join(PATHS.stickersDir, stickerFileName);
    const stickerRelativePath = path.posix.join('stickers', stickerFileName);
    await fs.writeFile(stickerFullPath, stickerBuffer);

    let hasAudioTrack = false;
    let audioInfo = null;
    if (meta.hasAudioStream) {
      await extractAudioFileToOggOpus(tempVideoPath, tempOggPath);
      const audioFileName = `${hash}.ogg`;
      const audioFullPath = path.join(PATHS.soundsDir, audioFileName);
      const audioRelativePath = path.posix.join('sounds', audioFileName);
      await fs.copyFile(tempOggPath, audioFullPath);
      hasAudioTrack = true;
      audioInfo = {
        fullPath: audioFullPath,
        relativePath: audioRelativePath,
        fileName: audioFileName,
      };
    }

    return {
      hash,
      durationSeconds: meta.durationSeconds,
      stickerBuffer,
      stickerFileName,
      stickerFullPath,
      stickerRelativePath,
      hasAudioTrack,
      audio: audioInfo,
    };
  } finally {
    await cleanupTempFiles([tempVideoPath, tempWebpPath, tempOggPath]);
  }
}

export async function removeAudioFile(filePath) {
  if (!filePath) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
}

/**
 * Mengonversi video bersuara menjadi WhatsApp Video Note bulat (ptv: true)
 * dalam format MP4 (H.264 + AAC, rasio 1:1 384x384, maks. 60 detik).
 */
export async function convertVideoToVideoNote(videoBuffer, inputExt = '.mp4') {
  assertFfmpegAvailable();
  await ensureTempDir();

  const tempId = crypto.randomUUID();
  const tempIn = await saveTempVideo(videoBuffer, inputExt);
  const tempOut = path.join(PATHS.tempDir, `ptv-out-${tempId}.mp4`);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tempIn)
        .setDuration(60)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .outputOptions([
          '-vf',
          'scale=384:384:force_original_aspect_ratio=increase,crop=384:384',
          '-pix_fmt',
          'yuv420p',
          '-profile:v',
          'baseline',
          '-level',
          '3.0',
          '-movflags',
          '+faststart',
          '-preset',
          'veryfast',
          '-crf',
          '26',
        ])
        .format('mp4')
        .on('end', resolve)
        .on('error', reject)
        .save(tempOut);
    });

    return await fs.readFile(tempOut);
  } finally {
    await cleanupTempFiles([tempIn, tempOut]);
  }
}

/**
 * Mengonversi gambar (JPG, PNG, WebP) menjadi stiker statis WhatsApp (.webp 512x512).
 */
export async function convertImageToSticker(imageBuffer, inputExt = '.jpg') {
  assertFfmpegAvailable();
  await ensureTempDir();

  const safeExt = inputExt.startsWith('.') ? inputExt : `.${inputExt}`;
  const tempId = crypto.randomUUID();
  const tempIn = path.join(PATHS.tempDir, `img-in-${tempId}${safeExt}`);
  const tempOut = path.join(PATHS.tempDir, `img-out-${tempId}.webp`);

  await fs.writeFile(tempIn, imageBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tempIn)
        .videoCodec('libwebp')
        .outputOptions([
          '-vf',
          'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
          '-vframes',
          '1',
          '-q:v',
          '80',
        ])
        .format('webp')
        .on('end', resolve)
        .on('error', reject)
        .save(tempOut);
    });

    return await fs.readFile(tempOut);
  } finally {
    await cleanupTempFiles([tempIn, tempOut]);
  }
}

/**
 * Mengonversi stiker WhatsApp (.webp) menjadi gambar PNG (.png) untuk perintah .toimg.
 */
export async function convertStickerToImage(webpBuffer) {
  assertFfmpegAvailable();
  await ensureTempDir();

  const tempId = crypto.randomUUID();
  const tempIn = path.join(PATHS.tempDir, `stk-in-${tempId}.webp`);
  const tempOut = path.join(PATHS.tempDir, `stk-out-${tempId}.png`);

  await fs.writeFile(tempIn, webpBuffer);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(tempIn)
        .outputOptions(['-vframes', '1'])
        .format('image2')
        .on('end', resolve)
        .on('error', reject)
        .save(tempOut);
    });

    return await fs.readFile(tempOut);
  } finally {
    await cleanupTempFiles([tempIn, tempOut]);
  }
}
