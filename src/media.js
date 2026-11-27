import crypto from 'node:crypto';
import path from 'node:path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from './config.js';

/**
 * Membuka wrapper pesan Baileys seperti ephemeralMessage atau viewOnceMessage.
 */
export function unwrapMessage(message) {
  let current = message;
  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else if (current.editedMessage?.message) {
      current = current.editedMessage.message;
    } else {
      break;
    }
  }
  return current ?? null;
}

export function getMessageText(unwrapped) {
  if (!unwrapped) return '';
  return (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.documentMessage?.caption ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    unwrapped.audioMessage?.caption ||
    ''
  ).trim();
}

export function getContextInfo(unwrapped) {
  if (!unwrapped) return null;
  return (
    unwrapped.extendedTextMessage?.contextInfo ||
    unwrapped.audioMessage?.contextInfo ||
    unwrapped.documentMessage?.contextInfo ||
    unwrapped.stickerMessage?.contextInfo ||
    unwrapped.audioStickerMessage?.contextInfo ||
    unwrapped.imageMessage?.contextInfo ||
    unwrapped.videoMessage?.contextInfo ||
    null
  );
}

/**
 * Membangun objek WAMessage dari pesan yang di-reply agar bisa diunduh
 * menggunakan downloadMediaMessage.
 */
export function getQuotedMessage(msg, unwrapped) {
  const contextInfo = getContextInfo(unwrapped);
  if (!contextInfo?.quotedMessage) return null;

  const quotedUnwrapped = unwrapMessage(contextInfo.quotedMessage);
  if (!quotedUnwrapped) return null;

  return {
    waMessage: {
      key: {
        remoteJid: msg.key.remoteJid,
        fromMe: false,
        id: contextInfo.stanzaId,
        participant: contextInfo.participant,
      },
      message: quotedUnwrapped,
    },
    unwrapped: quotedUnwrapped,
  };
}

export function isAudioDocument(documentMessage) {
  if (!documentMessage) return false;
  const mime = (documentMessage.mimetype || '').toLowerCase();
  if (mime.startsWith('audio/')) return true;

  const fileName = (documentMessage.fileName || '').toLowerCase();
  const ext = path.extname(fileName);
  return AUDIO_EXTENSIONS.has(ext);
}

export function isVideoDocument(documentMessage) {
  if (!documentMessage) return false;
  const mime = (documentMessage.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return true;

  const fileName = (documentMessage.fileName || '').toLowerCase();
  const ext = path.extname(fileName);
  return VIDEO_EXTENSIONS.has(ext);
}

export function hasSticker(unwrapped) {
  return Boolean(unwrapped?.stickerMessage);
}

export function hasAudio(unwrapped) {
  return Boolean(unwrapped?.audioMessage || isAudioDocument(unwrapped?.documentMessage));
}

export function hasVideo(unwrapped) {
  return Boolean(unwrapped?.videoMessage || isVideoDocument(unwrapped?.documentMessage));
}

export function hasImage(unwrapped) {
  if (unwrapped?.imageMessage) return true;
  const doc = unwrapped?.documentMessage;
  if (!doc) return false;
  const mime = (doc.mimetype || '').toLowerCase();
  return mime.startsWith('image/') && !mime.includes('webp');
}

export function getImageMetadata(unwrapped) {
  const mime = (
    unwrapped?.imageMessage?.mimetype ||
    unwrapped?.documentMessage?.mimetype ||
    'image/jpeg'
  ).toLowerCase();
  let ext = '.jpg';
  if (mime.includes('png')) ext = '.png';
  else if (mime.includes('webp')) ext = '.webp';
  else if (mime.includes('gif')) ext = '.gif';
  return { mimetype: mime, ext };
}

export function getVideoMetadata(unwrapped) {
  if (unwrapped?.videoMessage) {
    const v = unwrapped.videoMessage;
    const mime = (v.mimetype || 'video/mp4').toLowerCase();
    return {
      mimetype: mime,
      ext: guessVideoExtFromMime(mime),
      seconds: typeof v.seconds === 'number' ? v.seconds : null,
      fileLength: v.fileLength ? Number(v.fileLength) : null,
      gifPlayback: Boolean(v.gifPlayback),
    };
  }

  if (isVideoDocument(unwrapped?.documentMessage)) {
    const doc = unwrapped.documentMessage;
    const mime = (doc.mimetype || 'video/mp4').toLowerCase();
    const extFromName = path.extname(doc.fileName || '').toLowerCase();
    return {
      mimetype: mime,
      ext: VIDEO_EXTENSIONS.has(extFromName) ? extFromName : guessVideoExtFromMime(mime),
      seconds: null,
      fileLength: doc.fileLength ? Number(doc.fileLength) : null,
      gifPlayback: false,
    };
  }

  return null;
}

function guessVideoExtFromMime(mime) {
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
  if (mime.includes('matroska') || mime.includes('mkv')) return '.mkv';
  if (mime.includes('3gpp')) return '.3gp';
  return '.mp4';
}

export function getAudioMetadata(unwrapped) {
  if (unwrapped?.audioMessage) {
    const mime = (unwrapped.audioMessage.mimetype || 'audio/ogg').toLowerCase();
    return {
      mimetype: mime,
      ext: guessExtensionFromMime(mime),
      isVoiceNote: Boolean(unwrapped.audioMessage.ptt),
    };
  }

  if (isAudioDocument(unwrapped?.documentMessage)) {
    const doc = unwrapped.documentMessage;
    const mime = (doc.mimetype || 'application/octet-stream').toLowerCase();
    const extFromName = path.extname(doc.fileName || '').toLowerCase();
    return {
      mimetype: mime,
      ext: AUDIO_EXTENSIONS.has(extFromName) ? extFromName : guessExtensionFromMime(mime),
      isVoiceNote: false,
    };
  }

  return null;
}

function guessExtensionFromMime(mime) {
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('ogg') || mime.includes('opus')) return '.ogg';
  if (mime.includes('flac')) return '.flac';
  if (mime.includes('webm')) return '.webm';
  return '.audio';
}

export async function downloadMediaBuffer(waMessage, sock, logger) {
  const buffer = await downloadMediaMessage(
    waMessage,
    'buffer',
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    }
  );
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Gagal mengunduh media atau buffer kosong.');
  }
  return buffer;
}

export function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Mendeteksi sound sticker (termasuk format eksperimental / tidak resmi):
 * 1. audioStickerMessage
 * 2. stickerMessage yang memiliki properti audioMessage / audioData / sound
 * 3. stickerMessage yang berpasangan dengan audioMessage di pesan utama / quotedMessage
 */
export function detectSoundSticker(unwrapped, quotedUnwrapped = null) {
  if (!unwrapped && !quotedUnwrapped) {
    return { detected: false, isPlainSticker: false, kind: null };
  }

  // 1. Format eksperimental: audioStickerMessage
  if (unwrapped?.audioStickerMessage) {
    return {
      detected: true,
      isPlainSticker: false,
      kind: 'audioStickerMessage',
      stickerNode: unwrapped.audioStickerMessage,
      audioNode: unwrapped.audioStickerMessage.audioMessage || null,
      source: 'current',
    };
  }

  // 2. stickerMessage yang menyematkan properti audioMessage / audioData / sound
  if (unwrapped?.stickerMessage) {
    const stk = unwrapped.stickerMessage;
    const embeddedAudio = stk.audioMessage || stk.audioData || stk.sound || stk.associatedAudio || null;
    if (embeddedAudio) {
      return {
        detected: true,
        isPlainSticker: false,
        kind: 'stickerWithAudio',
        stickerNode: stk,
        audioNode: embeddedAudio,
        source: 'current',
      };
    }

    // 3a. stickerMessage yang me-reply pesan audio / voice note
    if (quotedUnwrapped && hasAudio(quotedUnwrapped)) {
      return {
        detected: true,
        isPlainSticker: false,
        kind: 'stickerAndAudio',
        stickerNode: stk,
        audioNode: quotedUnwrapped.audioMessage || quotedUnwrapped.documentMessage,
        source: 'current_sticker_quoted_audio',
      };
    }

    return {
      detected: false,
      isPlainSticker: true,
      kind: 'stickerOnly',
      stickerNode: stk,
      audioNode: null,
      source: 'current',
    };
  }

  // 3b. Pesan audio / voice note yang me-reply stickerMessage
  if (unwrapped && hasAudio(unwrapped) && quotedUnwrapped?.stickerMessage) {
    return {
      detected: true,
      isPlainSticker: false,
      kind: 'stickerAndAudio',
      stickerNode: quotedUnwrapped.stickerMessage,
      audioNode: unwrapped.audioMessage || unwrapped.documentMessage,
      source: 'current_audio_quoted_sticker',
    };
  }

  return { detected: false, isPlainSticker: false, kind: null };
}

/**
 * Mencetak struktur kunci pesan (Object.keys(msg.message) & quotedMessage) ke console
 * setiap kali stiker/sound sticker diterima atau di-reply, atau saat DEBUG_STICKER=true.
 */
export function logMessageKeyStructure(msg, unwrapped, quoted, force = false) {
  const debugEnabled =
    force ||
    process.env.DEBUG_STICKER === 'true' ||
    String(process.env.LOG_LEVEL || '').toLowerCase() === 'debug';
  if (!debugEnabled) return;

  const summary = {
    id: msg?.key?.id,
    fromMe: Boolean(msg?.key?.fromMe),
    messageKeys: msg?.message ? Object.keys(msg.message) : [],
    unwrappedKeys: unwrapped ? Object.keys(unwrapped) : [],
    quotedKeys: quoted?.unwrapped ? Object.keys(quoted.unwrapped) : [],
  };

  if (unwrapped?.stickerMessage) {
    summary.stickerMessageKeys = Object.keys(unwrapped.stickerMessage);
  }
  if (unwrapped?.audioStickerMessage) {
    summary.audioStickerMessageKeys = Object.keys(unwrapped.audioStickerMessage);
  }
  if (quoted?.unwrapped?.stickerMessage) {
    summary.quotedStickerKeys = Object.keys(quoted.unwrapped.stickerMessage);
  }
  if (quoted?.unwrapped?.audioStickerMessage) {
    summary.quotedAudioStickerKeys = Object.keys(quoted.unwrapped.audioStickerMessage);
  }

  console.log('[STICKER_KEYS]', JSON.stringify(summary));
}
