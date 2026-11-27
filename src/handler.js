import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BOT_CONFIG, DEFAULT_SESSION_FEATURES, PATHS } from './config.js';
import {
  deleteSticker,
  getSticker,
  getTotalStickers,
  resolveAudioFullPath,
  setSticker,
} from './database.js';
import {
  cleanupTempFiles,
  convertImageToSticker,
  convertStickerToImage,
  convertToVoiceNote,
  convertVideoFileToAnimatedWebp,
  convertVideoFileToSquareClip,
  convertVideoToVideoNote,
  extractAudioFileToOggOpus,
  inspectVideoFile,
  removeAudioFile,
  saveTempVideo,
  synthesizeTtsBuffer,
} from './audio.js';
import {
  computeSha256,
  detectSoundSticker,
  downloadMediaBuffer,
  getAudioMetadata,
  getContextInfo,
  getImageMetadata,
  getMessageText,
  getQuotedMessage,
  getVideoMetadata,
  hasAudio,
  hasImage,
  hasSticker,
  hasVideo,
  logMessageKeyStructure,
  unwrapMessage,
} from './media.js';
import {
  findSoundStickerByHash,
  getSoundSticker,
  isRelayChatEnabled,
  listSoundStickers,
  normalizeStickName,
  saveSoundSticker,
  setRelayChatEnabled,
} from './soundStickerStore.js';

// Menyimpan sesi sementara untuk alur .setsuara 2 langkah: key = `${chatId}::${senderId}`
const pendingSessions = new Map();

// Melacak ID pesan stiker yang dikirim bot sendiri (hasil .stiker / .stick / relay) agar tidak memicu loop
const botSentStickerIds = new Set();

// Ring buffer pesan terakhir (maks 500) agar payload WAMessage utuh tersedia saat di-reply .simpanstick
const recentMessages = new Map();
const MAX_RECENT_MESSAGES = 500;

function rememberIncomingMessage(msg) {
  const id = msg?.key?.id;
  if (!id) return;
  recentMessages.set(id, msg);
  if (recentMessages.size > MAX_RECENT_MESSAGES) {
    const oldestKey = recentMessages.keys().next().value;
    recentMessages.delete(oldestKey);
  }
}

function rememberBotStickerId(messageId) {
  if (!messageId) return;
  botSentStickerIds.add(messageId);
  // Bersihkan setelah 2 menit agar memori tetap ringan
  setTimeout(() => botSentStickerIds.delete(messageId), 2 * 60 * 1000);
}

function getSessionKey(msg) {
  const chatId = msg.key.remoteJid;
  const senderId = msg.key.fromMe ? 'self' : msg.key.participant || msg.key.remoteJid;
  return `${chatId}::${senderId}`;
}

function getPendingSession(key) {
  const session = pendingSessions.get(key);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    pendingSessions.delete(key);
    return null;
  }
  return session;
}

function setPendingSession(key, data) {
  pendingSessions.set(key, {
    ...data,
    expiresAt: Date.now() + BOT_CONFIG.pendingSessionTtlMs,
  });
}

function randomDelayMs() {
  const { replyDelayMinMs, replyDelayMaxMs } = BOT_CONFIG;
  return Math.floor(Math.random() * (replyDelayMaxMs - replyDelayMinMs + 1)) + replyDelayMinMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replyText(sock, msg, text) {
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function registerStickerSound({ sock, msg, stickerHash, audioBuffer, audioMeta, onStickersChanged }) {
  const outputFileName = `${stickerHash}.ogg`;
  const converted = await convertToVoiceNote(audioBuffer, outputFileName, audioMeta.ext);

  const createdBy = msg.key.participant || msg.key.remoteJid;
  await setSticker(stickerHash, {
    label: `Stiker ${stickerHash.slice(0, 8)}`,
    audioPath: converted.relativePath,
    fileName: converted.fileName,
    originalMime: audioMeta.mimetype,
    createdBy,
    createdAt: new Date().toISOString(),
  });
  await onStickersChanged?.();

  await replyText(
    sock,
    msg,
    [
      '✅ *Suara stiker berhasil disimpan!*',
      `• *ID Stiker (SHA-256):* \`${stickerHash.slice(0, 16)}...\``,
      `• *File Audio:* \`${converted.relativePath}\``,
      '',
      'Kirim stiker tersebut di chat pribadi atau grup untuk memutar Voice Note secara otomatis.',
    ].join('\n')
  );
}

async function handleMenu(sock, msg, sessionConfig) {
  const total = await getTotalStickers();
  const p = sessionConfig.prefix;
  const f = sessionConfig.features;
  const botName = sessionConfig.name || 'Bot Stiker Bersuara';

  const lines = [
    `🤖 *${botName}*`,
    `Prefix: \`${p}\` · Total stiker bersuara: *${total}*`,
    '',
    '*Daftar Perintah Aktif:*',
  ];

  if (f.stickerMaker) {
    lines.push(
      `• \`${p}stikersuara\` / \`${p}stiker\` / \`${p}s\` — Kirim/reply gambar atau video singkat (≤ ${BOT_CONFIG.maxStickerVideoSeconds} dtk) jadi stiker + Voice Note`
    );
  }
  if (f.stickerToImage) {
    lines.push(`• \`${p}toimg\` — Reply stiker untuk diubah kembali menjadi gambar PNG`);
  }
  if (f.videoNote) {
    lines.push(
      `• \`${p}videostiker\` / \`${p}gifsuara\` — Kirim/reply video singkat jadi klip bersuara dalam 1 pesan`
    );
    lines.push(
      `• \`${p}ptv\` — Kirim/reply video jadi *Video Note bulat* (video + suara menyatu)`
    );
  }
  if (f.soundSticker) {
    lines.push(
      `• \`${p}simpanstick <nama>\` — Reply sound sticker/stiker untuk disimpan ke arsip`
    );
    lines.push(`• \`${p}stick <nama>\` — Kirim/teruskan ulang sound sticker tersimpan`);
    lines.push(`• \`${p}liststick\` — Daftar semua nama sound sticker tersimpan`);
    lines.push(`• \`${p}relaystick on/off\` — Aktifkan/matikan kirim ulang & arsip otomatis sound sticker`);
    lines.push(
      `• \`${p}setsuara\` — Reply stiker + audio/video/VN atau ketik \`${p}setsuara <teks>\` (TTS)`
    );
    lines.push(`• \`${p}hapussuara\` — Reply stiker untuk menghapus suaranya`);
    lines.push(`• \`${p}info\` — Reply stiker untuk melihat hash SHA-256 & statusnya`);
  }
  lines.push(`• \`${p}menu\` — Menampilkan daftar perintah ini`);

  await replyText(sock, msg, lines.join('\n'));
}

async function handleInfo(sock, msg, unwrapped, logger) {
  const quoted = getQuotedMessage(msg, unwrapped);
  if (!quoted || !hasSticker(quoted.unwrapped)) {
    await replyText(
      sock,
      msg,
      `ℹ️ Reply sebuah *stiker* lalu ketik \`${BOT_CONFIG.prefix}info\` untuk melihat hash SHA-256 stiker tersebut.`
    );
    return;
  }

  const buffer = await downloadMediaBuffer(quoted.waMessage, sock, logger);
  const hash = computeSha256(buffer);
  const record = await getSticker(hash);

  const lines = [
    '🔍 *Info Stiker*',
    `• *SHA-256:* \`${hash}\``,
    `• *Status Suara:* ${record ? '✅ Terdaftar' : '❌ Belum terdaftar'}`,
  ];

  if (record) {
    lines.push(`• *File Audio:* \`${record.audioPath}\``);
    lines.push(`• *Ditambahkan:* ${record.createdAt}`);
  }

  await replyText(sock, msg, lines.join('\n'));
}

async function handleHapusSuara(sock, msg, unwrapped, logger, onStickersChanged) {
  const quoted = getQuotedMessage(msg, unwrapped);
  if (!quoted || !hasSticker(quoted.unwrapped)) {
    await replyText(
      sock,
      msg,
      `ℹ️ Reply *stiker* yang ingin dihapus suaranya lalu ketik \`${BOT_CONFIG.prefix}hapussuara\`.`
    );
    return;
  }

  const buffer = await downloadMediaBuffer(quoted.waMessage, sock, logger);
  const hash = computeSha256(buffer);
  const removed = await deleteSticker(hash);

  if (!removed) {
    await replyText(sock, msg, '⚠️ Stiker ini belum memiliki suara yang terdaftar.');
    return;
  }

  const fullAudioPath = resolveAudioFullPath(removed.audioPath);
  const fullStickerPath = resolveAudioFullPath(removed.stickerPath);
  await removeAudioFile(fullAudioPath);
  await removeAudioFile(fullStickerPath);
  await onStickersChanged?.();

  await replyText(
    sock,
    msg,
    `🗑️ Suara untuk stiker \`${hash.slice(0, 16)}...\` berhasil dihapus.`
  );
}

/**
 * Alur 2-tahap konversi video -> stiker animasi WebP + ekstraksi audio asli OGG Opus:
 * - File sementara disimpan di temp/ dan selalu dibersihkan di blok finally.
 * - Error handling terpisah antara tahap WebP dan tahap ekstraksi audio agar bot tidak crash.
 */
async function processVideoToAnimatedStickerAndVoiceNote({
  sock,
  msg,
  videoTarget,
  customLabel,
  logger,
  onStickersChanged,
  sessionConfig,
  isAutoMode = false,
}) {
  const maxSec = BOT_CONFIG.maxStickerVideoSeconds;
  const maxMb = Math.round(BOT_CONFIG.maxVideoSizeBytes / (1024 * 1024));
  const videoMeta = getVideoMetadata(videoTarget.unwrapped);

  if (!videoMeta) return;

  // Cek cepat metadata WhatsApp sebelum mengunduh buffer video
  if (videoMeta.seconds !== null && videoMeta.seconds > maxSec) {
    if (!isAutoMode) {
      await replyText(
        sock,
        msg,
        `⚠️ Video terlalu panjang (${videoMeta.seconds} detik). Maksimal durasi untuk stiker animasi adalah *${maxSec} detik* agar ringan dan valid di WhatsApp.`
      );
    }
    return;
  }

  if (videoMeta.fileLength !== null && videoMeta.fileLength > BOT_CONFIG.maxVideoSizeBytes) {
    if (!isAutoMode) {
      await replyText(
        sock,
        msg,
        `⚠️ Ukuran video terlalu besar. Maksimal *${maxMb} MB* agar konversi tidak berat.`
      );
    }
    return;
  }

  let tempVideoPath = null;
  let tempWebpPath = null;
  let tempOggPath = null;

  try {
    if (!isAutoMode) {
      await replyText(
        sock,
        msg,
        '⏳ Sedang mengunduh video, membuat stiker animasi, dan mengekstrak audio aslinya...'
      );
    }

    // 1. Unduh buffer video dan simpan ke file sementara di folder temp/
    const videoBuffer = await downloadMediaBuffer(videoTarget.waMessage, sock, logger);
    if (videoBuffer.length > BOT_CONFIG.maxVideoSizeBytes) {
      if (!isAutoMode) {
        await replyText(sock, msg, `⚠️ Ukuran video melebihi batas maksimal ${maxMb} MB.`);
      }
      return;
    }

    tempVideoPath = await saveTempVideo(videoBuffer, videoMeta.ext);

    // 2. Cek durasi aktual & keberadaan trek audio menggunakan FFmpeg
    const probe = await inspectVideoFile(tempVideoPath);
    if (probe.durationSeconds !== null && probe.durationSeconds > maxSec) {
      if (!isAutoMode) {
        await replyText(
          sock,
          msg,
          `⚠️ Durasi video terlalu panjang (${probe.durationSeconds} detik). Maksimal *${maxSec} detik*.`
        );
      }
      return;
    }

    const tempId = crypto.randomUUID();
    tempWebpPath = path.join(PATHS.tempDir, `sticker-out-${tempId}.webp`);
    tempOggPath = path.join(PATHS.tempDir, `audio-out-${tempId}.ogg`);

    // 3. Proses Pertama: Konversi video -> stiker animasi WebP 512x512, lalu kirim
    let webpBuffer;
    try {
      webpBuffer = await convertVideoFileToAnimatedWebp(tempVideoPath, tempWebpPath);
    } catch (webpErr) {
      console.error(`❌ [${sessionConfig.name}] Tahap WebP gagal:`, webpErr.message);
      await replyText(
        sock,
        msg,
        `❌ Gagal mengonversi video menjadi stiker animasi: ${webpErr.message}`
      );
      return;
    }

    const sentSticker = await sock.sendMessage(
      msg.key.remoteJid,
      { sticker: webpBuffer },
      { quoted: msg }
    );
    rememberBotStickerId(sentSticker?.key?.id);

    const hash = computeSha256(webpBuffer);
    console.log(
      `🎬 [${sessionConfig.name}] Stiker animasi terkirim -> hash=${hash.slice(0, 12)} hasAudio=${probe.hasAudioStream}`
    );

    // 4. Proses Kedua: Ekstrak audio asli video -> OGG Opus, lalu kirim sebagai Voice Note
    if (!probe.hasAudioStream) {
      if (!isAutoMode) {
        await replyText(
          sock,
          msg,
          'ℹ️ Stiker animasi berhasil dikirim, namun video tersebut *tidak memiliki trek audio asli*.'
        );
      }
      return;
    }

    try {
      await extractAudioFileToOggOpus(tempVideoPath, tempOggPath);

      // Beri jeda singkat agar urutan stiker -> Voice Note alami di chat
      await sleep(randomDelayMs());

      // Kirim audio asli hasil ekstraksi sebagai Voice Note yang me-reply stiker tadi
      await sock.sendMessage(
        msg.key.remoteJid,
        {
          audio: { url: tempOggPath },
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        },
        { quoted: sentSticker || msg }
      );

      // Simpan ke database/sounds/stickers agar bisa diputar ulang saat stiker dikirim lagi & tampil di Web UI
      if (sessionConfig.features.soundSticker) {
        await fs.mkdir(PATHS.soundsDir, { recursive: true });
        await fs.mkdir(PATHS.stickersDir, { recursive: true });
        const audioFileName = `${hash}.ogg`;
        const stickerFileName = `${hash}.webp`;
        await fs.copyFile(tempOggPath, path.join(PATHS.soundsDir, audioFileName));
        await fs.writeFile(path.join(PATHS.stickersDir, stickerFileName), webpBuffer);

        const createdBy = msg.key.participant || msg.key.remoteJid;
        await setSticker(hash, {
          label: customLabel || `Stiker Video ${hash.slice(0, 8)}`,
          audioPath: path.posix.join('sounds', audioFileName),
          fileName: audioFileName,
          stickerPath: path.posix.join('stickers', stickerFileName),
          originalMime: videoMeta.mimetype,
          createdBy,
          createdAt: new Date().toISOString(),
        });
        await onStickersChanged?.();
      }
    } catch (audioErr) {
      console.error(`❌ [${sessionConfig.name}] Tahap ekstraksi audio gagal:`, audioErr.message);
      await replyText(
        sock,
        msg,
        `⚠️ Stiker animasi berhasil dikirim, namun gagal mengekstrak audio asli video: ${audioErr.message}`
      );
    }
  } finally {
    // Selalu bersihkan seluruh file sementara di folder temp/
    await cleanupTempFiles([tempVideoPath, tempWebpPath, tempOggPath]);
  }
}

async function handleMediaToSticker(sock, msg, unwrapped, text, logger, onStickersChanged, sessionConfig) {
  const p = sessionConfig.prefix;
  const quoted = getQuotedMessage(msg, unwrapped);
  const currentHasVideo = hasVideo(unwrapped);
  const quotedHasVideo = Boolean(quoted && hasVideo(quoted.unwrapped));
  const currentHasImage = hasImage(unwrapped);
  const quotedHasImage = Boolean(quoted && hasImage(quoted.unwrapped));

  // Kasus A: Gambar -> Stiker statis WebP 512x512
  if (currentHasImage || quotedHasImage) {
    const imgTarget = currentHasImage
      ? { waMessage: { key: msg.key, message: unwrapped }, unwrapped }
      : { waMessage: quoted.waMessage, unwrapped: quoted.unwrapped };

    const imgMeta = getImageMetadata(imgTarget.unwrapped);
    const imgBuffer = await downloadMediaBuffer(imgTarget.waMessage, sock, logger);
    const webpBuffer = await convertImageToSticker(imgBuffer, imgMeta.ext);

    const sentSticker = await sock.sendMessage(
      msg.key.remoteJid,
      { sticker: webpBuffer },
      { quoted: msg }
    );
    rememberBotStickerId(sentSticker?.key?.id);
    return;
  }

  // Kasus B: Video -> Stiker animasi WebP + ekstrak audio asli OGG Opus
  if (!currentHasVideo && !quotedHasVideo) {
    await replyText(
      sock,
      msg,
      [
        `🎨 Kirim *gambar* atau *video bersuara* (maks. ${BOT_CONFIG.maxStickerVideoSeconds} detik) dengan caption \`${p}stikersuara\` atau \`${p}stiker\` (atau reply gambar/video).`,
        `Contoh dengan nama: \`${p}stikersuara Ketawa Ngakak\`.`,
      ].join('\n')
    );
    return;
  }

  const videoTarget = currentHasVideo
    ? { waMessage: { key: msg.key, message: unwrapped }, unwrapped }
    : { waMessage: quoted.waMessage, unwrapped: quoted.unwrapped };

  const customLabel = text.replace(/^\S+\s*/, '').trim().slice(0, 60);

  await processVideoToAnimatedStickerAndVoiceNote({
    sock,
    msg,
    videoTarget,
    customLabel,
    logger,
    onStickersChanged,
    sessionConfig,
    isAutoMode: false,
  });
}

async function handleStickerToImage(sock, msg, unwrapped, logger, sessionConfig) {
  const quoted = getQuotedMessage(msg, unwrapped);
  if (!quoted || !hasSticker(quoted.unwrapped)) {
    await replyText(
      sock,
      msg,
      `🖼️ Reply sebuah *stiker* lalu ketik \`${sessionConfig.prefix}toimg\` untuk mengubahnya menjadi gambar PNG.`
    );
    return;
  }

  const webpBuffer = await downloadMediaBuffer(quoted.waMessage, sock, logger);
  const pngBuffer = await convertStickerToImage(webpBuffer);

  await sock.sendMessage(
    msg.key.remoteJid,
    {
      image: pngBuffer,
      mimetype: 'image/png',
      caption: '✅ Stiker berhasil diubah ke gambar PNG.',
    },
    { quoted: msg }
  );
}

async function handleVideoToPtv(sock, msg, unwrapped, logger) {
  const quoted = getQuotedMessage(msg, unwrapped);
  const currentHasVideo = hasVideo(unwrapped);
  const quotedHasVideo = Boolean(quoted && hasVideo(quoted.unwrapped));

  if (!currentHasVideo && !quotedHasVideo) {
    await replyText(
      sock,
      msg,
      `🎥 Kirim *video bersuara* dengan caption \`${BOT_CONFIG.prefix}ptv\` (atau reply video dengan \`${BOT_CONFIG.prefix}ptv\`) untuk mengubahnya menjadi *Video Note bulat* (animasi + suara menyatu dalam 1 bubble).`
    );
    return;
  }

  const videoTarget = currentHasVideo
    ? { waMessage: { key: msg.key, message: unwrapped }, unwrapped }
    : { waMessage: quoted.waMessage, unwrapped: quoted.unwrapped };

  const videoMeta = getVideoMetadata(videoTarget.unwrapped);
  const videoBuffer = await downloadMediaBuffer(videoTarget.waMessage, sock, logger);
  const ptvBuffer = await convertVideoToVideoNote(videoBuffer, videoMeta.ext);

  await sock.sendMessage(
    msg.key.remoteJid,
    {
      video: ptvBuffer,
      mimetype: 'video/mp4',
      ptv: true,
    },
    { quoted: msg }
  );
}

async function handleVideoStickerClip(sock, msg, unwrapped, logger, sessionConfig) {
  const p = sessionConfig.prefix;
  const quoted = getQuotedMessage(msg, unwrapped);
  const currentHasVideo = hasVideo(unwrapped);
  const quotedHasVideo = Boolean(quoted && hasVideo(quoted.unwrapped));

  if (!currentHasVideo && !quotedHasVideo) {
    await replyText(
      sock,
      msg,
      `🎞️ Kirim *video singkat bersuara* dengan caption \`${p}videostiker\` atau \`${p}gifsuara\` (atau reply video) agar visual gerak & suara tampil dalam 1 pesan.`
    );
    return;
  }

  const videoTarget = currentHasVideo
    ? { waMessage: { key: msg.key, message: unwrapped }, unwrapped }
    : { waMessage: quoted.waMessage, unwrapped: quoted.unwrapped };

  const videoMeta = getVideoMetadata(videoTarget.unwrapped);
  if (videoMeta?.fileLength && videoMeta.fileLength > BOT_CONFIG.maxVideoSizeBytes) {
    const maxMb = Math.round(BOT_CONFIG.maxVideoSizeBytes / (1024 * 1024));
    await replyText(sock, msg, `⚠️ Ukuran video terlalu besar. Maksimal ${maxMb} MB.`);
    return;
  }

  let tempVideoPath = null;
  let tempMp4Path = null;

  try {
    const videoBuffer = await downloadMediaBuffer(videoTarget.waMessage, sock, logger);
    tempVideoPath = await saveTempVideo(videoBuffer, videoMeta.ext);
    tempMp4Path = path.join(PATHS.tempDir, `clip-out-${crypto.randomUUID()}.mp4`);

    await convertVideoFileToSquareClip(tempVideoPath, tempMp4Path);

    await sleep(randomDelayMs());
    await sock.sendMessage(
      msg.key.remoteJid,
      {
        video: { url: tempMp4Path },
        mimetype: 'video/mp4',
        gifPlayback: false,
      },
      { quoted: msg }
    );
  } catch (err) {
    console.error(`❌ [${sessionConfig.name}] .videostiker gagal:`, err.message);
    await replyText(sock, msg, `❌ Gagal membuat klip video bersuara: ${err.message}`);
  } finally {
    await cleanupTempFiles([tempVideoPath, tempMp4Path]);
  }
}

async function handleSetSuara(sock, msg, unwrapped, text, logger, onStickersChanged) {
  const sessionKey = getSessionKey(msg);
  const existingSession = getPendingSession(sessionKey);
  const quoted = getQuotedMessage(msg, unwrapped);

  const currentHasAudio = hasAudio(unwrapped);
  const currentHasVideo = hasVideo(unwrapped);
  const quotedHasSticker = Boolean(quoted && hasSticker(quoted.unwrapped));
  const quotedHasAudio = Boolean(quoted && hasAudio(quoted.unwrapped));
  const quotedHasVideo = Boolean(quoted && hasVideo(quoted.unwrapped));
  const ttsText = text.replace(/^\S+\s*/, '').trim();

  // Kasus 0: Reply stiker + teks TTS (contoh: .setsuara Halo semuanya!)
  if (quotedHasSticker && !currentHasAudio && !currentHasVideo && ttsText.length > 0) {
    pendingSessions.delete(sessionKey);
    const stickerBuffer = await downloadMediaBuffer(quoted.waMessage, sock, logger);
    const stickerHash = computeSha256(stickerBuffer);
    const ttsMp3Buffer = await synthesizeTtsBuffer(ttsText, 'id');
    await registerStickerSound({
      sock,
      msg,
      stickerHash,
      audioBuffer: ttsMp3Buffer,
      audioMeta: { mimetype: 'audio/mpeg', ext: '.mp3', isVoiceNote: false },
      onStickersChanged,
    });
    return;
  }

  // Kasus 1: 1 langkah — pesan ini melampirkan audio atau video sambil me-reply stiker
  if ((currentHasAudio || currentHasVideo) && quotedHasSticker) {
    pendingSessions.delete(sessionKey);
    const stickerBuffer = await downloadMediaBuffer(quoted.waMessage, sock, logger);
    const stickerHash = computeSha256(stickerBuffer);
    const mediaBuffer = await downloadMediaBuffer(
      { key: msg.key, message: unwrapped },
      sock,
      logger
    );
    const audioMeta = currentHasAudio
      ? getAudioMetadata(unwrapped)
      : { mimetype: getVideoMetadata(unwrapped).mimetype, ext: getVideoMetadata(unwrapped).ext };
    await registerStickerSound({
      sock,
      msg,
      stickerHash,
      audioBuffer: mediaBuffer,
      audioMeta,
      onStickersChanged,
    });
    return;
  }

  // Kasus 2: User me-reply stiker dengan .setsuara
  if (quotedHasSticker) {
    const stickerBuffer = await downloadMediaBuffer(quoted.waMessage, sock, logger);
    const stickerHash = computeSha256(stickerBuffer);

    // Jika sebelumnya sudah menyimpan audio di sesi 2 langkah, langsung pasangkan
    if (existingSession?.mode === 'awaiting_sticker') {
      pendingSessions.delete(sessionKey);
      await registerStickerSound({
        sock,
        msg,
        stickerHash,
        audioBuffer: existingSession.audioBuffer,
        audioMeta: existingSession.audioMeta,
        onStickersChanged,
      });
      return;
    }

    setPendingSession(sessionKey, {
      mode: 'awaiting_audio',
      stickerHash,
    });

    await replyText(
      sock,
      msg,
      [
        '🎯 *Stiker terdeteksi!*',
        `ID: \`${stickerHash.slice(0, 16)}...\``,
        '',
        'Sekarang kirim *Voice Note*, *file audio* (MP3/WAV/M4A), atau *video bersuara* dalam 2 menit — atau langsung reply stiker dengan `.setsuara <teks>` untuk suara TTS.',
      ].join('\n')
    );
    return;
  }

  // Kasus 3: User me-reply audio/VN/video dengan .setsuara ATAU melampirkan audio/video dengan caption .setsuara
  if (quotedHasAudio || currentHasAudio || quotedHasVideo || currentHasVideo) {
    const isQuoted = quotedHasAudio || quotedHasVideo;
    const isVideoSource = isQuoted ? quotedHasVideo : currentHasVideo;
    const target = isQuoted
      ? { waMessage: quoted.waMessage, unwrapped: quoted.unwrapped }
      : { waMessage: { key: msg.key, message: unwrapped }, unwrapped };

    const mediaBuffer = await downloadMediaBuffer(target.waMessage, sock, logger);
    const audioMeta = isVideoSource
      ? { mimetype: getVideoMetadata(target.unwrapped).mimetype, ext: getVideoMetadata(target.unwrapped).ext }
      : getAudioMetadata(target.unwrapped);

    // Jika sebelumnya sudah memilih stiker di sesi 2 langkah, langsung pasangkan
    if (existingSession?.mode === 'awaiting_audio') {
      pendingSessions.delete(sessionKey);
      await registerStickerSound({
        sock,
        msg,
        stickerHash: existingSession.stickerHash,
        audioBuffer: mediaBuffer,
        audioMeta,
        onStickersChanged,
      });
      return;
    }

    setPendingSession(sessionKey, {
      mode: 'awaiting_sticker',
      audioBuffer: mediaBuffer,
      audioMeta,
    });

    await replyText(
      sock,
      msg,
      '🎧 *Audio/video diterima!* Sekarang kirim *stiker* target (atau reply stiker dengan `.setsuara`) dalam 2 menit untuk menyimpannya.'
    );
    return;
  }

  // Kasus 4: Tidak ada stiker maupun audio/video
  await replyText(
    sock,
    msg,
    [
      '⚠️ *Cara menggunakan `.setsuara`:*',
      '• *Teks TTS:* Reply stiker lalu ketik `.setsuara Halo semuanya!`',
      '• *Audio / VN / Video:* Reply stiker lalu ketik `.setsuara`, kemudian kirim Voice Note, file audio, atau video bersuara.',
      '• *1 Langkah:* Reply stiker sambil melampirkan dokumen audio/video dengan caption `.setsuara`.',
    ].join('\n')
  );
}

async function tryCompletePendingSession(sock, msg, unwrapped, logger, onStickersChanged) {
  const sessionKey = getSessionKey(msg);
  const session = getPendingSession(sessionKey);
  if (!session) return false;

  if (session.mode === 'awaiting_audio' && (hasAudio(unwrapped) || hasVideo(unwrapped))) {
    pendingSessions.delete(sessionKey);
    const isVideoSrc = !hasAudio(unwrapped) && hasVideo(unwrapped);
    const audioBuffer = await downloadMediaBuffer(
      { key: msg.key, message: unwrapped },
      sock,
      logger
    );
    const audioMeta = isVideoSrc
      ? { mimetype: getVideoMetadata(unwrapped).mimetype, ext: getVideoMetadata(unwrapped).ext }
      : getAudioMetadata(unwrapped);
    await registerStickerSound({
      sock,
      msg,
      stickerHash: session.stickerHash,
      audioBuffer,
      audioMeta,
      onStickersChanged,
    });
    return true;
  }

  if (session.mode === 'awaiting_sticker' && hasSticker(unwrapped)) {
    pendingSessions.delete(sessionKey);
    const stickerBuffer = await downloadMediaBuffer(
      { key: msg.key, message: unwrapped },
      sock,
      logger
    );
    const stickerHash = computeSha256(stickerBuffer);
    await registerStickerSound({
      sock,
      msg,
      stickerHash,
      audioBuffer: session.audioBuffer,
      audioMeta: session.audioMeta,
      onStickersChanged,
    });
    return true;
  }

  return false;
}

/**
 * Mengirim / meneruskan kembali objek pesan sound sticker tersimpan secara langsung
 * menggunakan relayMessage atau forwardMessage (TANPA fallback ke voice note ptt: true).
 */
export async function sendSavedSoundSticker(sock, chatId, record, quotedMsg = null) {
  const quoteOpt = quotedMsg ? { quoted: quotedMsg } : {};
  const errors = [];

  if (!record?.rawMessage?.message) {
    throw new Error('Payload pesan tersimpan kosong atau tidak valid.');
  }

  // 1. Coba kirim ulang langsung menggunakan relayMessage (mempertahankan struktur protobuf mentah)
  if (typeof sock.relayMessage === 'function') {
    try {
      const messageId = await sock.relayMessage(chatId, record.rawMessage.message, {});
      if (typeof messageId === 'string') {
        rememberBotStickerId(messageId);
      }
      return { ok: true, method: 'relayMessage', messageId };
    } catch (err) {
      errors.push(`relayMessage: ${err.message}`);
    }
  }

  // 2. Coba teruskan langsung menggunakan forwardMessage ({ forward: rawMessage })
  if (typeof sock.sendMessage === 'function') {
    try {
      const sent = await sock.sendMessage(
        chatId,
        { forward: record.rawMessage },
        quoteOpt
      );
      rememberBotStickerId(sent?.key?.id);
      return { ok: true, method: 'forward', sent };
    } catch (err) {
      errors.push(`forward: ${err.message}`);
    }
  }

  throw new Error(errors.join(' | ') || 'Gagal mengirim ulang objek pesan tersimpan.');
}

async function handleSimpanStick(sock, msg, unwrapped, text, logger, sessionConfig) {
  const p = sessionConfig.prefix;
  const rawName = text.replace(/^\S+\s*/, '').trim();
  const key = normalizeStickName(rawName);
  const quoted = getQuotedMessage(msg, unwrapped);

  // Selalu cetak struktur kunci pesan & quotedMessage ke terminal saat .simpanstick dipanggil
  logMessageKeyStructure(msg, unwrapped, quoted, true);

  if (!key) {
    await replyText(
      sock,
      msg,
      `ℹ️ Reply pesan sound sticker/stiker lalu ketik \`${p}simpanstick <nama>\` (contoh: \`${p}simpanstick ketawa\`).`
    );
    return;
  }

  if (!quoted) {
    await replyText(
      sock,
      msg,
      `⚠️ Anda harus me-reply pesan stiker atau sound sticker saat mengetik \`${p}simpanstick ${key}\`.`
    );
    return;
  }

  const contextInfo = getContextInfo(unwrapped);
  const fullOriginalMsg =
    (contextInfo?.stanzaId && recentMessages.get(contextInfo.stanzaId)) || quoted.waMessage;
  const targetUnwrapped = unwrapMessage(fullOriginalMsg?.message) || quoted.unwrapped;
  const detection = detectSoundSticker(targetUnwrapped, null);

  if (!detection.detected && !detection.isPlainSticker) {
    await replyText(
      sock,
      msg,
      '⚠️ Pesan yang di-reply bukan stiker atau sound sticker.'
    );
    return;
  }

  // Hitung hash SHA-256 jika buffer stiker bisa diunduh (TANPA mengekstrak/membuat file voice note)
  let hash = null;
  try {
    const stickerBuf = await downloadMediaBuffer(fullOriginalMsg, sock, logger);
    hash = computeSha256(stickerBuf);
  } catch (dlErr) {
    console.warn(
      `⚠️ [${sessionConfig.name}] Hash buffer .simpanstick tidak tersedia (tetap simpan objek pesan):`,
      dlErr.message
    );
  }

  await saveSoundSticker(key, {
    kind: detection.kind || 'stickerOnly',
    hash,
    messageKeys: fullOriginalMsg?.message ? Object.keys(fullOriginalMsg.message) : [],
    savedBy: msg.key.participant || msg.key.remoteJid,
    savedAt: new Date().toISOString(),
    rawMessage: fullOriginalMsg,
  });

  await replyText(
    sock,
    msg,
    [
      `✅ Objek sound sticker disimpan dengan nama *${key}*!`,
      `• *Format:* \`${detection.kind || 'stickerOnly'}\``,
      ...(hash ? [`• *Hash:* \`${hash.slice(0, 16)}...\``] : []),
      `• Kirim ulang dengan \`${p}stick ${key}\`.`,
    ].join('\n')
  );
}

async function handleSendStick(sock, msg, text, sessionConfig) {
  const p = sessionConfig.prefix;
  const rawName = text.replace(/^\S+\s*/, '').trim();
  const key = normalizeStickName(rawName);

  if (!key) {
    await replyText(
      sock,
      msg,
      `ℹ️ Ketik \`${p}stick <nama>\` untuk mengirim sound sticker tersimpan. Lihat daftar dengan \`${p}liststick\`.`
    );
    return;
  }

  const record = await getSoundSticker(key);
  if (!record) {
    await replyText(
      sock,
      msg,
      `❌ Sound sticker *${key}* tidak ditemukan. Cek daftar tersimpan dengan \`${p}liststick\`.`
    );
    return;
  }

  try {
    await sleep(randomDelayMs());
    await sendSavedSoundSticker(sock, msg.key.remoteJid, record, msg);
  } catch (err) {
    console.error(`❌ [${sessionConfig.name}] Gagal mengirim .stick ${key}:`, err.message);
    await replyText(
      sock,
      msg,
      `⚠️ Gagal mengirim ulang *${key}*: ${err.message}`
    );
  }
}

async function handleListStick(sock, msg, sessionConfig) {
  const p = sessionConfig.prefix;
  const items = await listSoundStickers();

  if (items.length === 0) {
    await replyText(
      sock,
      msg,
      `📂 Belum ada sound sticker yang disimpan. Reply stiker lalu ketik \`${p}simpanstick <nama>\`.`
    );
    return;
  }

  const lines = [
    `🎵 *Daftar Sound Sticker Tersimpan (${items.length}):*`,
    '',
    ...items.map(
      (item, idx) =>
        `${idx + 1}. \`${item.name}\` — _${item.kind || 'sticker'}_${item.hash ? ` (${item.hash.slice(0, 8)}…)` : ''}`
    ),
    '',
    `Kirim dengan: \`${p}stick <nama>\``,
  ];

  await replyText(sock, msg, lines.join('\n'));
}

async function handleRelayStickToggle(sock, msg, text, sessionConfig) {
  const p = sessionConfig.prefix;
  const arg = text.replace(/^\S+\s*/, '').trim().toLowerCase();
  const chatId = msg.key.remoteJid;

  if (arg === 'on' || arg === 'aktif') {
    await setRelayChatEnabled(chatId, true);
    await replyText(
      sock,
      msg,
      '✅ Mode *Relay Sound Sticker* diaktifkan untuk chat ini. Sound sticker yang masuk akan otomatis dikirim ulang / diarsipkan.'
    );
    return;
  }

  if (arg === 'off' || arg === 'nonaktif') {
    await setRelayChatEnabled(chatId, false);
    await replyText(sock, msg, '🛑 Mode *Relay Sound Sticker* dimatikan untuk chat ini.');
    return;
  }

  const active = await isRelayChatEnabled(chatId);
  await replyText(
    sock,
    msg,
    `ℹ️ Status *Relay Sound Sticker* di chat ini: *${active ? 'ON (Aktif)' : 'OFF (Nonaktif)'}*.\nGunakan \`${p}relaystick on\` atau \`${p}relaystick off\`.`
  );
}

async function tryAutoRelaySoundSticker(sock, msg, unwrapped, quoted, logger, sessionConfig) {
  if (msg.key.fromMe || botSentStickerIds.has(msg.key.id)) return false;

  const chatId = msg.key.remoteJid;
  const enabled = await isRelayChatEnabled(chatId);
  if (!enabled) return false;

  const detection = detectSoundSticker(unwrapped, quoted?.unwrapped || null);
  if (!detection.detected && !detection.isPlainSticker) return false;

  let hash = null;
  try {
    const buf = await downloadMediaBuffer({ key: msg.key, message: unwrapped }, sock, logger);
    hash = computeSha256(buf);
  } catch {
    // Tetap lanjut meski media eksperimental tidak bisa diunduh langsung
  }

  // 1. Jika cocok dengan sound sticker yang sudah tersimpan -> teruskan ulang dengan aman
  if (hash) {
    const saved = await findSoundStickerByHash(hash);
    if (saved) {
      try {
        await sleep(randomDelayMs());
        await sendSavedSoundSticker(sock, chatId, saved, msg);
        console.log(`🔁 [${sessionConfig.name}] Relay sound sticker "${saved.name}"`);
        return true;
      } catch (err) {
        console.warn(`⚠️ [${sessionConfig.name}] Relay "${saved.name}" gagal:`, err.message);
        return false;
      }
    }
  }

  // 2. Jika terdeteksi sound sticker eksperimental baru -> arsipkan otomatis tanpa crash
  if (detection.detected) {
    try {
      const autoName = `auto_${hash ? hash.slice(0, 8) : Date.now().toString(36)}`;
      await saveSoundSticker(autoName, {
        kind: detection.kind,
        hash,
        savedBy: msg.key.participant || chatId,
        savedAt: new Date().toISOString(),
        rawMessage: msg,
        stickerPath: null,
        audioPath: null,
      });
      console.log(`📦 [${sessionConfig.name}] Sound sticker eksperimental (${detection.kind}) diarsipkan sebagai "${autoName}"`);
    } catch (err) {
      console.warn(`⚠️ [${sessionConfig.name}] Gagal mengarsipkan sound sticker:`, err.message);
    }
  }

  return false;
}

async function handleAutoReplySticker(sock, msg, unwrapped, logger) {
  // Hindari loop dari pesan bot sendiri
  if (msg.key.fromMe || botSentStickerIds.has(msg.key.id)) return;

  const stickerBuffer = await downloadMediaBuffer(
    { key: msg.key, message: unwrapped },
    sock,
    logger
  );
  const hash = computeSha256(stickerBuffer);
  const record = await getSticker(hash);
  if (!record) {
    console.log(`ℹ️ Stiker masuk (${hash.slice(0, 12)}...) belum terdaftar di database.`);
    return;
  }

  const fullAudioPath = resolveAudioFullPath(record.audioPath);
  if (!fullAudioPath) return;

  try {
    await fs.access(fullAudioPath);
  } catch {
    logger.warn({ hash, fullAudioPath }, 'File audio stiker tidak ditemukan di disk');
    return;
  }

  console.log(`🎵 Stiker cocok (${hash.slice(0, 12)}...) -> mengirim Voice Note.`);
  await sleep(randomDelayMs());

  await sock.sendMessage(
    msg.key.remoteJid,
    {
      audio: { url: fullAudioPath },
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    },
    { quoted: msg }
  );
}

export async function handleIncomingMessage(sock, msg, logger, options = {}) {
  const { onStickersChanged } = options;
  const sessionConfig = {
    id: options.sessionConfig?.id || 'utama',
    name: options.sessionConfig?.name || 'Bot Stiker Bersuara',
    prefix: options.sessionConfig?.prefix || BOT_CONFIG.prefix,
    features: { ...DEFAULT_SESSION_FEATURES, ...(options.sessionConfig?.features || {}) },
  };
  const prefixLower = sessionConfig.prefix.toLowerCase();

  try {
    if (!msg?.message) return;
    if (msg.key.remoteJid === 'status@broadcast') return;

    rememberIncomingMessage(msg);

    const unwrapped = unwrapMessage(msg.message);
    if (!unwrapped) return;

    const quoted = getQuotedMessage(msg, unwrapped);
    const stickerDetect = detectSoundSticker(unwrapped, quoted?.unwrapped || null);
    const quotedDetect = quoted ? detectSoundSticker(quoted.unwrapped, null) : { detected: false, isPlainSticker: false };
    const isStickerEvent =
      stickerDetect.detected ||
      stickerDetect.isPlainSticker ||
      quotedDetect.detected ||
      quotedDetect.isPlainSticker;

    // Selalu cetak Object.keys(msg.message) & quotedMessage saat stiker/sound sticker diterima atau di-reply
    logMessageKeyStructure(msg, unwrapped, quoted, isStickerEvent);

    const text = getMessageText(unwrapped);
    const lowerText = text.toLowerCase();

    // 1. Cek apakah pesan berupa perintah bot sesuai prefix sesi
    if (lowerText.startsWith(prefixLower)) {
      const command = lowerText.slice(prefixLower.length).split(/\s+/)[0];

      switch (command) {
        case 'menu':
        case 'help':
          await handleMenu(sock, msg, sessionConfig);
          return;
        case 'simpanstick':
        case 'savestick':
          if (!sessionConfig.features.soundSticker) return;
          await handleSimpanStick(sock, msg, unwrapped, text, logger, sessionConfig);
          return;
        case 'stick':
        case 'sendstick':
          if (!sessionConfig.features.soundSticker) return;
          await handleSendStick(sock, msg, text, sessionConfig);
          return;
        case 'liststick':
          if (!sessionConfig.features.soundSticker) return;
          await handleListStick(sock, msg, sessionConfig);
          return;
        case 'relaystick':
          if (!sessionConfig.features.soundSticker) return;
          await handleRelayStickToggle(sock, msg, text, sessionConfig);
          return;
        case 'stiker':
        case 'sticker':
        case 's':
        case 'stikersuara':
          if (!sessionConfig.features.stickerMaker) return;
          await handleMediaToSticker(
            sock,
            msg,
            unwrapped,
            text,
            logger,
            onStickersChanged,
            sessionConfig
          );
          return;
        case 'toimg':
        case 'toimage':
          if (!sessionConfig.features.stickerToImage) return;
          await handleStickerToImage(sock, msg, unwrapped, logger, sessionConfig);
          return;
        case 'videostiker':
        case 'gifsuara':
          if (!sessionConfig.features.videoNote) return;
          await handleVideoStickerClip(sock, msg, unwrapped, logger, sessionConfig);
          return;
        case 'ptv':
        case 'videonote':
        case 'stikervid':
        case 'sv':
          if (!sessionConfig.features.videoNote) return;
          await handleVideoToPtv(sock, msg, unwrapped, logger);
          return;
        case 'info':
          if (!sessionConfig.features.soundSticker) return;
          await handleInfo(sock, msg, unwrapped, logger);
          return;
        case 'setsuara':
          if (!sessionConfig.features.soundSticker) return;
          await handleSetSuara(sock, msg, unwrapped, text, logger, onStickersChanged);
          return;
        case 'hapussuara':
          if (!sessionConfig.features.soundSticker) return;
          await handleHapusSuara(sock, msg, unwrapped, logger, onStickersChanged);
          return;
        default:
          break;
      }
    }

    // 2. Mode otomatis: konversi semua video pendek (<= maxStickerVideoSeconds) tanpa perintah jika diaktifkan
    if (
      sessionConfig.features.autoVideoSticker &&
      !msg.key.fromMe &&
      unwrapped.videoMessage &&
      !unwrapped.videoMessage.gifPlayback
    ) {
      await processVideoToAnimatedStickerAndVoiceNote({
        sock,
        msg,
        videoTarget: { waMessage: { key: msg.key, message: unwrapped }, unwrapped },
        customLabel: text.slice(0, 60),
        logger,
        onStickersChanged,
        sessionConfig,
        isAutoMode: true,
      });
      return;
    }

    // 3. Cek apakah pesan menyelesaikan sesi .setsuara 2 langkah
    if (sessionConfig.features.soundSticker) {
      const completed = await tryCompletePendingSession(
        sock,
        msg,
        unwrapped,
        logger,
        onStickersChanged
      );
      if (completed) return;

      // 3b. Mode Relay Sound Sticker otomatis (.relaystick on) — tanpa voice note (ptt: true)
      await tryAutoRelaySoundSticker(
        sock,
        msg,
        unwrapped,
        quoted,
        logger,
        sessionConfig
      );
      // Auto-reply voice note (ptt: true) dinonaktifkan agar bot tidak mengirim voice note otomatis
    }
  } catch (error) {
    console.error(`⚠️ [${sessionConfig.name}] Error memproses pesan:`, error.message);
    logger.error({ err: error }, 'Terjadi kesalahan saat memproses pesan');
    if (msg?.key?.remoteJid && !msg.key.fromMe) {
      const text = getMessageText(unwrapMessage(msg.message));
      if (text.toLowerCase().startsWith(prefixLower)) {
        await replyText(
          sock,
          msg,
          `❌ Terjadi kesalahan saat memproses perintah: ${error.message}`
        ).catch(() => {});
      }
    }
  }
}
