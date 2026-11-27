import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';

const {
  default: makeWASocket,
  Browsers,
  DisconnectReason,
  convertVideoToSoundSticker,
  downloadMediaMessage,
  downloadVideoForSoundSticker,
  sendVideoAsSoundSticker,
  useMultiFileAuthState,
} = await import('@xbibzlibrary/whatsbibz');
const { default: pino } = await import('pino');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUTH_ROOT_DIR = path.join(__dirname, 'auth');
const DB_DIR = path.join(__dirname, 'database');
const STICKERS_DIR = path.join(__dirname, 'stickers');
const SOUNDS_DIR = path.join(__dirname, 'sounds');
const SESSIONS_DB_FILE = path.join(DB_DIR, 'wa_sessions.json');
const CREATED_STICKERS_FILE = path.join(DB_DIR, 'created_stickers.json');
const DEVELOPER_NAME = 'Rudi Dwi Lesmana';
const WEB_HOST = process.env.HOST || '0.0.0.0';
const WEB_PORT = Number(process.env.PORT || 3000);
const MAX_SESSIONS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLanAddresses(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const net of entries) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

function formatIndonesianPhone(raw) {
  let phone = String(raw || '').replace(/\D/g, '');
  if (phone.startsWith('0')) {
    phone = `62${phone.slice(1)}`;
  }
  return phone;
}

// Deteksi binary ffmpeg & ffprobe (prioritas sistem PATH, fallback otomatis ke ffmpeg-static / ffprobe-static)
async function resolveMediaBinaries() {
  let ffmpegPath = 'ffmpeg';
  let ffprobePath = 'ffprobe';

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    try {
      const mod = await import('ffmpeg-static');
      if (typeof mod.default === 'string' && mod.default) {
        ffmpegPath = mod.default;
      }
    } catch {
      // Gunakan default 'ffmpeg'
    }
  }

  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch {
    try {
      const mod = await import('ffprobe-static');
      const resolved = mod.default?.path || mod.path;
      if (typeof resolved === 'string' && resolved) {
        ffprobePath = resolved;
      }
    } catch {
      // Gunakan default 'ffprobe'
    }
  }

  return { ffmpegPath, ffprobePath };
}

const { ffmpegPath, ffprobePath } = await resolveMediaBinaries();
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

// Sesi sementara 2 langkah untuk perintah .gantisuara di WhatsApp (berlaku 2 menit)
const pendingCustomAudio = new Map();

const TIKTOK_URL_REGEX = /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i;

function extractTikTokUrl(text) {
  const match = String(text || '').match(TIKTOK_URL_REGEX);
  return match ? match[0] : null;
}

/**
 * Mengunduh video TikTok publik tanpa watermark (MP4) via TikWM API.
 * Memvalidasi host tiktok.com dan membatasi ukuran maksimal 20 MB.
 */
async function downloadTikTokVideo(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Format link TikTok tidak valid.');
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !/(^|\.)tiktok\.com$/i.test(parsed.hostname)
  ) {
    throw new Error('Link harus berasal dari domain tiktok.com (contoh: vt.tiktok.com atau www.tiktok.com).');
  }

  const apiRes = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
    },
    body: new URLSearchParams({ url: parsed.toString(), hd: '0' }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!apiRes.ok) {
    throw new Error(`Layanan downloader TikTok gagal merespons (HTTP ${apiRes.status}).`);
  }

  const json = await apiRes.json();
  if (json?.code !== 0 || !json?.data) {
    throw new Error(json?.msg || 'Video TikTok tidak ditemukan atau akun bersifat privat.');
  }

  const data = json.data;
  if (Array.isArray(data.images) && data.images.length > 0 && !data.play) {
    throw new Error('Link TikTok ini berupa slide foto, bukan video.');
  }

  const videoUrl = data.play || data.wmplay;
  if (!videoUrl) {
    throw new Error('Tautan video MP4 TikTok tidak tersedia.');
  }

  const mediaRes = await fetch(videoUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!mediaRes.ok) {
    throw new Error(`Gagal mengunduh file video TikTok (HTTP ${mediaRes.status}).`);
  }

  const buf = Buffer.from(await mediaRes.arrayBuffer());
  if (!buf.length) {
    throw new Error('File video TikTok yang diunduh kosong.');
  }
  if (buf.length > 20 * 1024 * 1024) {
    throw new Error('Ukuran video TikTok melebihi batas 20 MB.');
  }

  const cleanTitle = String(data.title || '').replace(/\s+/g, ' ').trim().slice(0, 45);
  return {
    buffer: buf,
    title: cleanTitle || `TikTok ${data.id || ''}`.trim(),
    author: data.author?.unique_id || 'tiktok',
  };
}

function extractPinterestUrl(text = '') {
  const match = String(text || '').match(
    /https?:\/\/(?:pin\.it|[a-z0-9-]+\.pinterest\.[a-z.]+|pinterest\.[a-z.]+)\/[^\s<>"]+/i
  );
  return match ? match[0].replace(/[),.!?;]+$/, '') : null;
}

function findPinterestPinObject(node, targetId, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (targetId && node[targetId] && typeof node[targetId] === 'object' && (node[targetId].images || node[targetId].videos)) {
    return node[targetId];
  }
  if ((node.videos?.video_list || node.story_pin_data?.pages || node.images?.orig?.url) && (!targetId || String(node.id || '') === String(targetId))) {
    return node;
  }
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') {
      const found = findPinterestPinObject(val, targetId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function pickPinterestVideoFromList(videoList) {
  if (!videoList || typeof videoList !== 'object') return { mp4: null, m3u8: null };
  const entries = Object.values(videoList).filter((v) => v && typeof v.url === 'string');
  const mp4 =
    videoList.V_720P?.url ||
    videoList.v720P?.url ||
    videoList.V_480P?.url ||
    videoList.v480P?.url ||
    videoList.V_EXP7?.url ||
    entries.find((v) => /\.mp4(\?|$)/i.test(v.url))?.url ||
    null;
  const m3u8 =
    videoList.V_HLSV4?.url ||
    videoList.vHLSV4?.url ||
    videoList.V_HLSV3_WEB?.url ||
    videoList.vHLSV3MOBILE?.url ||
    entries.find((v) => /\.m3u8(\?|$)/i.test(v.url))?.url ||
    null;
  return { mp4, m3u8 };
}

function extractPinterestVideoFromNode(node) {
  let mp4 = null;
  let m3u8 = null;
  if (!node || typeof node !== 'object') return { mp4, m3u8 };
  const candidates = [
    node.videoList720P,
    node.videoList,
    node.video_list,
    node.videoListMobile,
    node.v_hlsv4_video_list,
    node.videoListEXP7,
    node.videoListEXP6,
    node.videoListEXP5,
    node.videoListEXP4,
    node.videoListEXP3,
  ];
  for (const list of candidates) {
    const picked = pickPinterestVideoFromList(list);
    if (picked.mp4 && !mp4) mp4 = picked.mp4;
    if (picked.m3u8 && !m3u8) m3u8 = picked.m3u8;
  }
  return { mp4, m3u8 };
}

async function tryFetchDirectMp4FromHls(m3u8Url) {
  const candidates = [
    m3u8Url.replace('/hls/', '/expMp4/').replace(/\.m3u8(\?.*)?$/i, '_720w.mp4'),
    m3u8Url.replace('/hls/', '/720p/').replace(/\.m3u8(\?.*)?$/i, '.mp4'),
  ].filter((u) => u !== m3u8Url && /\.mp4$/i.test(u));

  for (const url of [...new Set(candidates)]) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 1024 && buf.length <= 20 * 1024 * 1024) {
        return buf;
      }
    } catch {
      // Coba kandidat berikutnya
    }
  }
  return null;
}

/**
 * Mengunduh stream HLS (.m3u8) Pinterest memakai Node fetch() ke file lokal terlebih dahulu
 * (agar tidak bergantung pada dukungan TLS/HTTPS di binary ffmpeg-static Linux), lalu remux ke MP4.
 */
async function downloadHlsToMp4Buffer(m3u8Url, maxSeconds = 20) {
  // 1. Coba langsung unduh versi MP4 720p jika tersedia di CDN Pinterest
  const directMp4 = await tryFetchDirectMp4FromHls(m3u8Url);
  if (directMp4) return directMp4;

  // 2. Unduh playlist .m3u8 + segmen secara lokal dengan Node fetch()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-pin-hls-'));
  const outMp4 = path.join(dir, 'pin.mp4');
  const fetchText = async (u) => {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  };

  try {
    let playlistUrl = m3u8Url;
    let playlistText = await fetchText(playlistUrl);

    // Jika master playlist (#EXT-X-STREAM-INF), pilih variant video (dan audio jika terpisah)
    let audioPlaylistUrl = null;
    if (playlistText.includes('#EXT-X-STREAM-INF')) {
      const lines = playlistText.split(/\r?\n/);
      const audioMatch = playlistText.match(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]+)"/i);
      if (audioMatch) {
        audioPlaylistUrl = new URL(audioMatch[1], playlistUrl).toString();
      }
      const variants = lines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      if (!variants.length) throw new Error('Variant HLS Pinterest tidak ditemukan.');
      playlistUrl = new URL(variants[variants.length - 1], playlistUrl).toString();
      playlistText = await fetchText(playlistUrl);
    }

    const downloadLocalPlaylist = async (plUrl, plText, prefix) => {
      const lines = plText.split(/\r?\n/);
      const outLines = [];
      let segIdx = 0;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        // Handle EXT-X-MAP:URI="..." untuk fMP4/cmfv
        if (line.startsWith('#EXT-X-MAP:')) {
          const uriMatch = line.match(/URI="([^"]+)"/i);
          if (uriMatch) {
            const abs = new URL(uriMatch[1], plUrl).toString();
            const ext = path.extname(new URL(abs).pathname) || '.mp4';
            const localName = `${prefix}_init${ext}`;
            const segRes = await fetch(abs, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
            if (segRes.ok) {
              await fs.writeFile(path.join(dir, localName), Buffer.from(await segRes.arrayBuffer()));
              outLines.push(line.replace(uriMatch[1], localName));
              continue;
            }
          }
          outLines.push(line);
          continue;
        }
        if (line.startsWith('#')) {
          outLines.push(line);
          continue;
        }
        const abs = new URL(line, plUrl).toString();
        const ext = path.extname(new URL(abs).pathname) || '.ts';
        const localName = `${prefix}_${segIdx++}${ext}`;
        const segRes = await fetch(abs, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
        if (!segRes.ok) throw new Error(`Gagal unduh segmen video Pinterest (HTTP ${segRes.status}).`);
        await fs.writeFile(path.join(dir, localName), Buffer.from(await segRes.arrayBuffer()));
        outLines.push(localName);
      }
      const localM3u8 = path.join(dir, `${prefix}.m3u8`);
      await fs.writeFile(localM3u8, outLines.join('\n') + '\n', 'utf8');
      return localM3u8;
    };

    const localVideoM3u8 = await downloadLocalPlaylist(playlistUrl, playlistText, 'vid');
    const args = ['-y', '-loglevel', 'error', '-allowed_extensions', 'ALL', '-i', localVideoM3u8];

    if (audioPlaylistUrl) {
      const audioText = await fetchText(audioPlaylistUrl);
      const localAudioM3u8 = await downloadLocalPlaylist(audioPlaylistUrl, audioText, 'aud');
      args.push('-allowed_extensions', 'ALL', '-i', localAudioM3u8, '-map', '0:v:0', '-map', '1:a:0?');
    }

    args.push(
      '-t',
      String(maxSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outMp4
    );

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { windowsHide: true, timeout: 60_000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`Gagal memproses stream video Pinterest: ${stderr?.slice(-200) || err.message}`));
        else resolve();
      });
    });

    const buf = await fs.readFile(outMp4);
    if (!buf.length) throw new Error('Stream video Pinterest kosong.');
    if (buf.length > 20 * 1024 * 1024) throw new Error('Ukuran video Pinterest melebihi 20 MB.');
    return buf;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Mengunduh media dari link Pinterest (pin.it / pinterest.com):
 * mendukung Pin Video (MP4 / HLS .m3u8), GIF, dan Gambar (JPG/PNG/WebP).
 */
async function downloadPinterestMedia(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Format link Pinterest tidak valid.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !(/^(?:pin\.it|(?:[a-z0-9-]+\.)*pinterest\.[a-z.]+)$/i.test(host))
  ) {
    throw new Error('Link harus berasal dari domain pin.it atau pinterest.com.');
  }

  const pageRes = await fetch(parsed.toString(), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });

  if (!pageRes.ok) {
    throw new Error(`Gagal membuka halaman Pinterest (HTTP ${pageRes.status}).`);
  }

  const finalUrl = pageRes.url || parsed.toString();
  const pinIdMatch = finalUrl.match(/\/pin\/(\d+)/);
  const pinId = pinIdMatch ? pinIdMatch[1] : null;
  let html = await pageRes.text();

  // Jika pin.it redirect ke halaman /sent/?invite_code=..., ambil halaman kanonis /pin/<id>/ agar metadata lengkap
  if (pinId && (!html.includes('v3GetPinQueryv2') && !html.includes('leaf-snippet'))) {
    const canonRes = await fetch(`https://www.pinterest.com/pin/${pinId}/`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    if (canonRes.ok) {
      html = await canonRes.text();
    }
  }

  let title = '';
  let mp4Url = null;
  let m3u8Url = null;
  let imageUrl = null;

  // 1. Parse Relay JSON (v3GetPinQueryv2) yang digunakan Pinterest modern
  for (const m of html.matchAll(/<script[^>]*data-relay-completed-request="true"[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1];
    if (!body.includes('v3GetPinQueryv2')) continue;
    const jsonStart = body.indexOf('{"data":');
    const jsonEnd = body.lastIndexOf(')');
    if (jsonStart === -1 || jsonEnd <= jsonStart) continue;
    try {
      const payload = JSON.parse(body.slice(jsonStart, jsonEnd));
      const pin = payload?.data?.v3GetPinQueryv2?.data;
      if (!pin || typeof pin !== 'object') continue;

      if (!title) {
        title = String(pin.title || pin.gridTitle || pin.description || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 45);
      }

      const directVid = extractPinterestVideoFromNode(pin.videos);
      if (directVid.mp4 && !mp4Url) mp4Url = directVid.mp4;
      if (directVid.m3u8 && !m3u8Url) m3u8Url = directVid.m3u8;

      const storyPages = pin.storyPinData?.pages || pin.story_pin_data?.pages;
      if (!mp4Url && Array.isArray(storyPages)) {
        for (const page of storyPages) {
          for (const block of page?.blocks || []) {
            const sv1 = extractPinterestVideoFromNode(block?.videoDataV2);
            const sv2 = extractPinterestVideoFromNode(block?.video);
            if (sv1.mp4 && !mp4Url) mp4Url = sv1.mp4;
            if (sv2.mp4 && !mp4Url) mp4Url = sv2.mp4;
            if (sv1.m3u8 && !m3u8Url) m3u8Url = sv1.m3u8;
            if (sv2.m3u8 && !m3u8Url) m3u8Url = sv2.m3u8;
          }
        }
      }

      if (!imageUrl) {
        imageUrl =
          pin.imageSpec_orig?.url ||
          pin.images?.orig?.url ||
          pin.imageSpec_736x?.url ||
          pin.images?.['736x']?.url ||
          pin.images_orig?.url ||
          pin.images_736x?.url ||
          null;
      }
    } catch {
      // Lanjut ke blok berikutnya
    }
  }

  // 2. Parse JSON-LD (leaf-snippet) jika masih belum lengkap
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const ld = JSON.parse(m[1]);
      if (!title && (ld.headline || ld.name)) {
        title = String(ld.headline || ld.name).replace(/\s+/g, ' ').trim().slice(0, 45);
      }
      if (!mp4Url && typeof ld.contentUrl === 'string' && /\.mp4(\?|$)/i.test(ld.contentUrl)) {
        mp4Url = ld.contentUrl;
      }
      if (!imageUrl && typeof ld.image === 'string' && ld.image.includes('pinimg.com')) {
        imageUrl = ld.image;
      }
    } catch {
      // Abaikan
    }
  }

  // 3. Fallback JSON __PWS_INITIAL_PROPS__
  if (!mp4Url && !m3u8Url && !imageUrl) {
    const pwsMatch = html.match(/<script[^>]*id="__PWS_INITIAL_PROPS__"[^>]*>([\s\S]*?)<\/script>/i);
    if (pwsMatch) {
      try {
        const props = JSON.parse(pwsMatch[1]);
        const pinsMap = props?.initialReduxState?.pins || {};
        const pin =
          (pinId && pinsMap[pinId]) ||
          Object.values(pinsMap)[0] ||
          findPinterestPinObject(props, pinId);

        if (pin) {
          if (!title) {
            title = String(pin.title || pin.grid_title || pin.closeup_unified_description || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 45);
          }

          const directVid = pickPinterestVideoFromList(pin.videos?.video_list);
          mp4Url = directVid.mp4;
          m3u8Url = directVid.m3u8;

          if (!mp4Url && !m3u8Url && Array.isArray(pin.story_pin_data?.pages)) {
            for (const page of pin.story_pin_data.pages) {
              for (const block of page?.blocks || []) {
                const sv = pickPinterestVideoFromList(block?.video?.video_list);
                if (sv.mp4) {
                  mp4Url = sv.mp4;
                  break;
                }
                if (sv.m3u8 && !m3u8Url) m3u8Url = sv.m3u8;
              }
              if (mp4Url) break;
            }
          }

          imageUrl =
            pin.images?.orig?.url ||
            pin.images?.['736x']?.url ||
            pin.images?.['564x']?.url ||
            null;
        }
      } catch {
        // Lanjut ke fallback regex HTML
      }
    }
  }

  // 4. Fallback regex langsung dari HTML halaman Pinterest (mendukung slash normal maupun escaped \/)
  if (!mp4Url) {
    const m = html.match(/https?:\\?\/\\?\/v\d*\.pinimg\.com[^"'\s]+?\.mp4(?:\?[^"'\s]*)?/i);
    if (m) mp4Url = m[0].replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
  }
  if (!mp4Url && !m3u8Url) {
    const m = html.match(/https?:\\?\/\\?\/v\d*\.pinimg\.com[^"'\s]+?\.m3u8(?:\?[^"'\s]*)?/i);
    if (m) m3u8Url = m[0].replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
  }
  if (!imageUrl) {
    const allOrigs =
      html.match(/https:\/\/i\.pinimg\.com\/originals\/[^"'\s\\]+?\.(?:gif|png|jpg|jpeg|webp)/gi) || [];
    const realOrig = allOrigs.find((u) => !u.includes('d53b014d86a6b6761bf649a0ed813c2b'));
    const allLarge =
      html.match(/https:\/\/i\.pinimg\.com\/736x\/[^"'\s\\]+?\.(?:gif|png|jpg|jpeg|webp)/gi) || [];
    const realLarge = allLarge.find((u) => !u.includes('d53b014d86a6b6761bf649a0ed813c2b'));
    imageUrl = realOrig || realLarge || null;
  }

  const cleanTitle = title || `Pinterest ${pinId || ''}`.trim();

  // Prioritas 1: Video MP4 langsung
  if (mp4Url) {
    const mediaRes = await fetch(mp4Url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!mediaRes.ok) {
      throw new Error(`Gagal mengunduh video Pinterest (HTTP ${mediaRes.status}).`);
    }
    const buf = Buffer.from(await mediaRes.arrayBuffer());
    if (!buf.length) throw new Error('File video Pinterest kosong.');
    if (buf.length > 20 * 1024 * 1024) throw new Error('Ukuran video Pinterest melebihi batas 20 MB.');
    return { kind: 'video', buffer: buf, title: cleanTitle, isGif: false };
  }

  // Prioritas 2: Video HLS (.m3u8) -> konversi ke MP4 via FFmpeg
  if (m3u8Url) {
    const buf = await downloadHlsToMp4Buffer(m3u8Url, 20);
    return { kind: 'video', buffer: buf, title: cleanTitle, isGif: false };
  }

  // Prioritas 3: Gambar / GIF Pinterest
  if (imageUrl) {
    const mediaRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!mediaRes.ok) {
      throw new Error(`Gagal mengunduh gambar Pinterest (HTTP ${mediaRes.status}).`);
    }
    const buf = Buffer.from(await mediaRes.arrayBuffer());
    if (!buf.length) throw new Error('File gambar Pinterest kosong.');
    const mime = (mediaRes.headers.get('content-type') || '').toLowerCase();
    const isGif = mime.includes('gif') || /\.gif(\?|$)/i.test(imageUrl);
    return { kind: 'image', buffer: buf, title: cleanTitle, isGif, mime };
  }

  throw new Error('Media video/gambar tidak ditemukan pada link Pinterest tersebut (pastikan pin bersifat publik).');
}

/**
 * Mengonversi gambar statis, GIF, atau video tanpa suara menjadi stiker WebP 512x512 (<= 500 KiB).
 */
async function convertMediaToWebpSticker(buffer, { isAnimated = false, isGif = false, startSeconds = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-webp-stk-'));
  const ext = isGif ? '.gif' : isAnimated ? '.mp4' : '.img';
  const inPath = path.join(dir, `in${ext}`);
  const outPath = path.join(dir, 'sticker.webp');
  const maxBytes = 500 * 1024;

  try {
    await fs.writeFile(inPath, buffer);

    if (!isAnimated && !isGif) {
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath,
          [
            '-y',
            '-loglevel',
            'error',
            '-i',
            inPath,
            '-vf',
            'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
            '-c:v',
            'libwebp',
            '-q:v',
            '85',
            '-compression_level',
            '6',
            outPath,
          ],
          { windowsHide: true, timeout: 30_000 },
          (err, _stdout, stderr) => {
            if (err) reject(new Error(`Gagal membuat stiker gambar: ${stderr?.slice(-200) || err.message}`));
            else resolve();
          }
        );
      });
      const webp = await fs.readFile(outPath);
      return { sticker: webp, isAnimated: false };
    }

    // Video tanpa suara atau GIF animasi -> WebP animasi 512x512 bersih (yuva420p + kualitas tinggi, maks 500 KiB)
    const presets = [
      [20, 62],
      [15, 55],
      [12, 50],
      [10, 45],
      [8, 38],
      [6, 30],
      [5, 22],
    ];
    for (const [fps, quality] of presets) {
      const filter = `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`;
      const args = ['-y', '-loglevel', 'error'];
      if (startSeconds > 0 && !isGif) args.push('-ss', String(startSeconds));
      args.push(
        '-i',
        inPath,
        '-t',
        '15',
        '-an',
        '-vf',
        filter,
        '-c:v',
        'libwebp_anim',
        '-preset',
        'default',
        '-q:v',
        String(quality),
        '-loop',
        '0',
        '-compression_level',
        '4',
        outPath
      );
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath, args, { windowsHide: true, timeout: 60_000 }, (err, _stdout, stderr) => {
          if (err) reject(new Error(`Gagal membuat stiker animasi: ${stderr?.slice(-200) || err.message}`));
          else resolve();
        });
      });
      const st = await fs.stat(outPath);
      if (st.size <= maxBytes) {
        return { sticker: await fs.readFile(outPath), isAnimated: true };
      }
    }
    throw new Error('Ukuran stiker animasi Pinterest melebihi batas 500 KiB.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Menggabungkan video (MP4/MOV) dengan trek audio kustom (MP3/WAV/M4A/OGG/WebM/VN)
 * menjadi buffer MP4 baru agar bisa langsung diproses oleh sendVideoAsSoundSticker.
 */
async function mergeVideoWithCustomAudio(videoBuffer, audioBuffer, audioExt = '.audio') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-custom-audio-'));
  const safeExt = audioExt.startsWith('.') ? audioExt : `.${audioExt}`;
  const videoIn = path.join(dir, 'in.mp4');
  const audioIn = path.join(dir, `in${safeExt}`);
  const mergedOut = path.join(dir, 'merged.mp4');

  try {
    await fs.writeFile(videoIn, videoBuffer);
    await fs.writeFile(audioIn, audioBuffer);

    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath,
        [
          '-y',
          '-i',
          videoIn,
          '-i',
          audioIn,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '48000',
          '-ac',
          '1',
          '-shortest',
          '-movflags',
          '+faststart',
          mergedOut,
        ],
        { windowsHide: true, timeout: 45_000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Gagal menggabungkan video & audio kustom: ${stderr?.slice(-200) || err.message}`));
          } else {
            resolve();
          }
        }
      );
    });

    return await fs.readFile(mergedOut);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function guessAudioExtFromMime(mime = '', originalName = '') {
  const ext = path.extname(originalName || '').toLowerCase();
  if (['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.aac', '.webm', '.flac'].includes(ext)) return ext;
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a';
  if (m.includes('ogg') || m.includes('opus')) return '.ogg';
  if (m.includes('webm')) return '.webm';
  return '.audio';
}

function unwrapWaMessage(message) {
  let current = message;
  while (current) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return current || null;
}

function hasAudioPayload(unwrapped) {
  if (!unwrapped) return false;
  if (unwrapped.audioMessage) return true;
  const doc = unwrapped.documentMessage;
  if (!doc) return false;
  const mime = (doc.mimetype || '').toLowerCase();
  const ext = path.extname(doc.fileName || '').toLowerCase();
  return mime.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.ogg', '.opus', '.aac'].includes(ext);
}

// State bersama multi-nomor antara bot WhatsApp & Web App (SSE)
const sessions = new Map();
const sseClients = new Set();
const activityLogs = [];
const stats = {
  stickersCreated: 0,
  pingsHandled: 0,
};
let registryWriteQueue = Promise.resolve();
let stickersWriteQueue = Promise.resolve();
let createdStickers = [];

async function loadCreatedStickers() {
  await fs.mkdir(DB_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(CREATED_STICKERS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    createdStickers = Array.isArray(parsed) ? parsed : [];
  } catch {
    createdStickers = [];
  }
  stats.stickersCreated = createdStickers.length;
}

function saveCreatedStickersFile() {
  const snapshot = JSON.stringify(createdStickers, null, 2) + '\n';
  stickersWriteQueue = stickersWriteQueue.then(async () => {
    await fs.mkdir(DB_DIR, { recursive: true });
    const tmp = `${CREATED_STICKERS_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, CREATED_STICKERS_FILE);
  });
  return stickersWriteQueue;
}

async function archiveCreatedSticker({ stickerBuffer, audioBuffer = null, seconds = 0, source, name }) {
  await fs.mkdir(STICKERS_DIR, { recursive: true });
  await fs.mkdir(SOUNDS_DIR, { recursive: true });
  const id = `stk_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  await fs.writeFile(path.join(STICKERS_DIR, `${id}.webp`), stickerBuffer);
  if (audioBuffer?.length) {
    await fs.writeFile(path.join(SOUNDS_DIR, `${id}.ogg`), audioBuffer);
  }

  const entry = {
    id,
    name: String(name || `Sound Sticker ${id.slice(-4)}`).slice(0, 50),
    source: source || 'Web',
    seconds: seconds || 0,
    stickerBytes: stickerBuffer.length,
    audioBytes: audioBuffer?.length || 0,
    createdAt: new Date().toISOString(),
  };

  createdStickers.unshift(entry);
  stats.stickersCreated = createdStickers.length;
  await saveCreatedStickersFile();
  broadcast('stickers', { stickers: createdStickers });
  broadcast('status', getStatusSnapshot());
  return entry;
}

async function removeCreatedSticker(id) {
  const idx = createdStickers.findIndex((item) => item.id === id);
  if (idx === -1) return false;
  createdStickers.splice(idx, 1);
  stats.stickersCreated = createdStickers.length;
  await saveCreatedStickersFile();
  await fs.rm(path.join(STICKERS_DIR, `${id}.webp`), { force: true }).catch(() => {});
  await fs.rm(path.join(SOUNDS_DIR, `${id}.ogg`), { force: true }).catch(() => {});
  broadcast('stickers', { stickers: createdStickers });
  broadcast('status', getStatusSnapshot());
  return true;
}

function broadcast(event, payload) {
  for (const send of sseClients) {
    send(event, payload);
  }
}

function serializeSession(rec) {
  return {
    id: rec.id,
    name: rec.name,
    status: rec.status, // connecting | pairing | open | close
    user: rec.user,
    lastPairingCode: rec.lastPairingCode,
    lastPairingPhone: rec.lastPairingPhone,
    createdAt: rec.createdAt,
  };
}

function getStatusSnapshot() {
  const list = [...sessions.values()]
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    .map(serializeSession);

  return {
    developer: DEVELOPER_NAME,
    fps: 24,
    maxSeconds: 15,
    totalCount: list.length,
    activeCount: list.filter((s) => s.status === 'open').length,
    sessions: list,
    stats: { ...stats },
    lanUrls: getLanAddresses(WEB_PORT),
    logs: activityLogs.slice(0, 25),
  };
}

function pushLog(message) {
  const entry = {
    time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
    message,
  };
  activityLogs.unshift(entry);
  if (activityLogs.length > 35) activityLogs.pop();
  broadcast('status', getStatusSnapshot());
}

function printStartupBanner() {
  console.log('========================================================');
  console.log('   🎵 WhatsApp Sound Sticker Bot (24 FPS · Multi-Nomor)');
  console.log(`   👨‍💻 Developer : ${DEVELOPER_NAME}`);
  console.log('========================================================');
  console.log('   Fitur & Perintah:');
  console.log('   • .menu       - Menampilkan info developer & daftar fitur');
  console.log('   • .ping       - Cek status bot (balas pong)');
  console.log('   • .Sticker    - Ubah video bersuara jadi sound sticker');
  console.log('   • .gantisuara - Ubah video jadi sound sticker dengan suara sendiri');
  console.log('   • .ttsticker  - Ekstrak video dari link TikTok jadi sound sticker');
  console.log('   • .pinsticker - Ekstrak video/gambar dari link Pinterest jadi sticker');
  console.log('========================================================\n');
}

function buildMenuText() {
  return [
    '🎵 *WhatsApp Sound Sticker Bot*',
    `👨‍💻 *Developer:* ${DEVELOPER_NAME}`,
    '',
    '*Daftar Fitur & Perintah:*',
    '• `.menu` — Menampilkan menu & daftar fitur bot',
    '• `.ping` — Mengecek apakah bot sedang aktif (`pong`)',
    '• `.Sticker` — Mengubah video bersuara menjadi *Sound Sticker*',
    '• `.gantisuara` — Mengganti suara video dengan *Voice Note / audio sendiri* lalu jadi Sound Sticker',
    '• `.ttsticker <link>` — Mengubah video dari *link TikTok* langsung menjadi Sound Sticker',
    '• `.pinsticker <link>` — Mengubah video/gambar dari *link Pinterest* menjadi Sticker / Sound Sticker',
    '',
    '*Cara Pakai `.Sticker`:*',
    '1. Kirim video MP4/MOV yang ada suaranya dengan caption `.Sticker`, atau',
    '2. Reply video bersuara di chat lalu ketik `.Sticker`.',
    '',
    '*Cara Pakai `.gantisuara`:*',
    '1. Kirim/reply video dengan `.gantisuara`.',
    '2. Lalu kirim *Voice Note* atau *file audio* (MP3/WAV/M4A) sebagai suara penggantinya.',
    '',
    '*Cara Pakai `.ttsticker` & `.pinsticker`:*',
    '• TikTok: `.ttsticker https://vt.tiktok.com/...` (opsional detik mulai: `.ttsticker <link> 5`).',
    '• Pinterest: `.pinsticker https://pin.it/...` (video bersuara jadi Sound Sticker, video/gambar lain jadi Sticker).',
    '',
    '_Catatan: Untuk akun sendiri, perintah aktif di self-chat._',
  ].join('\n');
}

function normalizeUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function isSelfChat(remoteJid, sock) {
  if (!remoteJid) return false;
  const target = normalizeUser(remoteJid);
  const myPhone = normalizeUser(sock.user?.id);
  const myLid = normalizeUser(sock.user?.lid);
  return Boolean(target && (target === myPhone || (myLid && target === myLid)));
}

function extractText(message) {
  if (!message) return '';
  let current = message;
  while (current) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
    else break;
  }
  return (
    current?.conversation ||
    current?.extendedTextMessage?.text ||
    current?.videoMessage?.caption ||
    current?.imageMessage?.caption ||
    ''
  ).trim();
}

function saveRegistry() {
  const data = {};
  for (const [id, rec] of sessions.entries()) {
    data[id] = {
      id: rec.id,
      name: rec.name,
      authDir: rec.authDir,
      createdAt: rec.createdAt,
    };
  }
  const snapshot = JSON.stringify(data, null, 2) + '\n';
  registryWriteQueue = registryWriteQueue.then(async () => {
    await fs.mkdir(DB_DIR, { recursive: true });
    const tmp = `${SESSIONS_DB_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, SESSIONS_DB_FILE);
  });
  return registryWriteQueue;
}

async function loadRegistry() {
  await fs.mkdir(DB_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(SESSIONS_DB_FILE, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function createRecord({ id, name, authDir, createdAt }) {
  return {
    id,
    name: String(name || id).trim().slice(0, 40) || id,
    authDir,
    createdAt: createdAt || new Date().toISOString(),
    status: 'connecting',
    user: null,
    lastPairingCode: null,
    lastPairingPhone: null,
    sock: null,
    reconnectTimer: null,
    isResetting: false,
    isDeleted: false,
  };
}

async function stopSessionSocket(rec, shouldLogout = false) {
  if (rec.reconnectTimer) {
    clearTimeout(rec.reconnectTimer);
    rec.reconnectTimer = null;
  }
  const sockToClose = rec.sock;
  const wasOpen = rec.status === 'open';
  rec.sock = null;

  if (sockToClose) {
    if (shouldLogout && wasOpen) {
      try {
        await Promise.race([sockToClose.logout(), sleep(3000)]);
      } catch {
        // Abaikan jika logout timeout
      }
    }
    try {
      sockToClose.end(undefined);
    } catch {
      // Abaikan
    }
    await sleep(300);
  }
}

async function clearSessionAuth(rec) {
  // Jika memakai root 'auth' (legacy nomor utama), hapus hanya file creds/key di dalamnya agar subfolder nomor lain aman
  if (path.resolve(rec.authDir) === path.resolve(AUTH_ROOT_DIR)) {
    const entries = await fs.readdir(AUTH_ROOT_DIR, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.isFile()) {
        await fs
          .rm(path.join(AUTH_ROOT_DIR, ent.name), { force: true, maxRetries: 5, retryDelay: 200 })
          .catch(() => {});
      }
    }
    return;
  }

  await fs.rm(rec.authDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  await fs.mkdir(rec.authDir, { recursive: true });
}

async function resetSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error('Sesi tidak ditemukan.');
  if (rec.isResetting) return serializeSession(rec);

  rec.isResetting = true;
  try {
    rec.status = 'connecting';
    rec.user = null;
    rec.lastPairingCode = null;
    rec.lastPairingPhone = null;
    pushLog(`🔄 [${rec.name}] Melepas pairing & mereset sesi...`);

    await stopSessionSocket(rec, true);
    await clearSessionAuth(rec);
  } finally {
    rec.isResetting = false;
  }

  if (!rec.isDeleted) {
    await connectSession(rec.id);
  }
  return serializeSession(rec);
}

async function deleteSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error('Sesi tidak ditemukan.');

  rec.isDeleted = true;
  rec.isResetting = true;
  await stopSessionSocket(rec, true);
  await clearSessionAuth(rec);

  if (path.resolve(rec.authDir) !== path.resolve(AUTH_ROOT_DIR)) {
    await fs.rm(rec.authDir, { recursive: true, force: true }).catch(() => {});
  }

  sessions.delete(sessionId);
  await saveRegistry();
  pushLog(`🗑️ [${rec.name}] Sesi dihapus.`);
  return { deleted: true, id: sessionId };
}

async function requestPairingForSession(sessionId, rawPhone) {
  const rec = sessions.get(sessionId);
  if (!rec) throw new Error('Sesi tidak ditemukan.');
  if (rec.status === 'open') {
    throw new Error(`Sesi "${rec.name}" sudah terhubung.`);
  }

  const phone = formatIndonesianPhone(rawPhone);
  if (phone.length < 10 || phone.length > 16) {
    throw new Error('Masukkan nomor WhatsApp yang valid (10–16 digit), misal 081234567890.');
  }

  // Pastikan socket sedang aktif dan siap menerima requestPairingCode
  if (!rec.sock) {
    await connectSession(rec.id);
  }

  // Tunggu maksimal 8 detik hingga WebSocket WhatsApp benar-benar siap menerima pairing (status === 'pairing')
  for (let i = 0; i < 32; i++) {
    if (rec.sock && rec.status === 'pairing') break;
    await sleep(250);
  }

  if (!rec.sock) {
    throw new Error('Socket WhatsApp belum siap. Coba klik Reset Sesi lalu Minta Kode lagi.');
  }

  const rawCode = await rec.sock.requestPairingCode(phone);
  const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
  rec.lastPairingCode = formattedCode;
  rec.lastPairingPhone = phone;
  pushLog(`🔑 [${rec.name}] Pairing code untuk ${phone}: ${formattedCode}`);
  return formattedCode;
}

async function connectSession(sessionId) {
  const rec = sessions.get(sessionId);
  if (!rec || rec.isDeleted) return;

  if (rec.reconnectTimer) {
    clearTimeout(rec.reconnectTimer);
    rec.reconnectTimer = null;
  }

  await fs.mkdir(rec.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(rec.authDir);

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    autoFollowChannel: false,
  });

  rec.sock = sock;
  rec.status = 'connecting';
  broadcast('status', getStatusSnapshot());

  sock.ev.on('creds.update', async () => {
    if (rec.isResetting || rec.isDeleted || rec.sock !== sock) return;
    try {
      await saveCreds();
    } catch {
      // Abaikan saat reset
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (rec.sock !== sock || rec.isResetting || rec.isDeleted) return;

    if (qr) {
      const wasPairing = rec.status === 'pairing';
      rec.status = 'pairing';
      rec.user = null;
      if (!wasPairing) {
        pushLog(`🔑 [${rec.name}] Siap pairing dengan nomor HP.`);
      } else {
        broadcast('status', getStatusSnapshot());
      }
    }

    if (connection === 'open') {
      rec.status = 'open';
      rec.lastPairingCode = null;
      rec.user = {
        id: sock.user?.id || null,
        name: sock.user?.name || 'Terhubung',
      };
      pushLog(`✅ [${rec.name}] Terhubung sebagai ${rec.user.name}`);
      console.log(`✅ [${rec.name}] Bot WhatsApp terhubung (${rec.user.name})!`);
    }

    if (connection === 'close') {
      rec.status = 'close';
      rec.user = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        pushLog(`⚠️ [${rec.name}] Sesi logout (401). Mereset agar siap pairing ulang...`);
        rec.reconnectTimer = setTimeout(() => {
          resetSession(rec.id).catch((err) => console.error(`Gagal reset ${rec.id}:`, err));
        }, 1500);
        return;
      }

      pushLog(`⚠️ [${rec.name}] Terputus (kode: ${statusCode ?? 'unknown'}). Reconnect 3 dtk...`);
      rec.reconnectTimer = setTimeout(() => {
        connectSession(rec.id).catch((err) => console.error(`Gagal reconnect ${rec.id}:`, err));
      }, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || rec.sock !== sock || rec.isDeleted) return;

    for (const msg of messages) {
      try {
        if (!msg?.message) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;

        // Pesan dari diri sendiri (fromMe) HANYA diproses di self-chat
        if (msg.key.fromMe && !isSelfChat(jid, sock)) continue;

        const text = extractText(msg.message);
        const cmd = text.toLowerCase().split(/\s+/)[0];

        if (cmd === '.menu' || cmd === '.help') {
          await sock.sendMessage(jid, { text: buildMenuText() }, { quoted: msg });
          pushLog(`📖 [${rec.name}] .menu -> ${normalizeUser(jid)}`);
          continue;
        }

        if (cmd === '.ping') {
          stats.pingsHandled += 1;
          await sock.sendMessage(jid, { text: 'pong' }, { quoted: msg });
          pushLog(`🏓 [${rec.name}] .ping -> pong (${normalizeUser(jid)})`);
          continue;
        }

        if (cmd === '.ttsticker' || cmd === '.tt' || cmd === '.tiktok') {
          const unwrappedForTt = unwrapWaMessage(msg.message);
          const quotedText = extractText(
            unwrappedForTt?.extendedTextMessage?.contextInfo?.quotedMessage
          );
          const ttUrl = extractTikTokUrl(text) || extractTikTokUrl(quotedText);
          if (!ttUrl) {
            await sock.sendMessage(
              jid,
              {
                text: '🔗 Kirim link TikTok setelah perintah, contoh:\n`.ttsticker https://vt.tiktok.com/...`\n(Opsional tambah detik mulai: `.ttsticker <link> 5`)',
              },
              { quoted: msg }
            );
            continue;
          }

          // Cek apakah ada angka detik mulai di argumen setelah link
          const afterUrl = text.replace(ttUrl, '').replace(/^\S+\s*/, '').trim();
          const parsedStart = Number(afterUrl);
          const startSeconds =
            Number.isFinite(parsedStart) && parsedStart >= 0 && parsedStart <= 3600
              ? parsedStart
              : 0;

          await sock.sendMessage(
            jid,
            { text: '⏳ Mengunduh video TikTok & membuat Sound Sticker...' },
            { quoted: msg }
          );
          pushLog(`🎵 [${rec.name}] Memproses .ttsticker dari ${normalizeUser(jid)}...`);

          try {
            const tt = await downloadTikTokVideo(ttUrl);
            await sendVideoAsSoundSticker(sock, jid, tt.buffer, {
              quoted: msg,
              startSeconds,
              ffmpegPath,
              ffprobePath,
            });
            pushLog(`✅ [${rec.name}] Sound sticker TikTok terkirim ke ${normalizeUser(jid)}`);
            convertVideoToSoundSticker(tt.buffer, { startSeconds, ffmpegPath, ffprobePath })
              .then((conv) =>
                archiveCreatedSticker({
                  stickerBuffer: conv.sticker,
                  audioBuffer: conv.audio,
                  seconds: conv.seconds,
                  source: 'TikTok WA',
                  name: tt.title,
                })
              )
              .catch(() => {});
          } catch (err) {
            pushLog(`❌ [${rec.name}] .ttsticker gagal: ${err?.message || err}`);
            await sock.sendMessage(
              jid,
              { text: `❌ Gagal ekstrak TikTok: ${err?.message || err}` },
              { quoted: msg }
            );
          }
          continue;
        }

        if (cmd === '.pinsticker' || cmd === '.pin' || cmd === '.pinterest') {
          const unwrappedForPin = unwrapWaMessage(msg.message);
          const quotedText = extractText(
            unwrappedForPin?.extendedTextMessage?.contextInfo?.quotedMessage
          );
          const pinUrl = extractPinterestUrl(text) || extractPinterestUrl(quotedText);
          if (!pinUrl) {
            await sock.sendMessage(
              jid,
              {
                text: '📌 Kirim link Pinterest setelah perintah, contoh:\n`.pinsticker https://pin.it/...`\n(Opsional tambah detik mulai untuk video: `.pinsticker <link> 5`)',
              },
              { quoted: msg }
            );
            continue;
          }

          const afterUrl = text.replace(pinUrl, '').replace(/^\S+\s*/, '').trim();
          const parsedStart = Number(afterUrl);
          const startSeconds =
            Number.isFinite(parsedStart) && parsedStart >= 0 && parsedStart <= 3600
              ? parsedStart
              : 0;

          await sock.sendMessage(
            jid,
            { text: '⏳ Mengunduh media Pinterest & membuat Sticker...' },
            { quoted: msg }
          );
          pushLog(`📌 [${rec.name}] Memproses .pinsticker dari ${normalizeUser(jid)}...`);

          try {
            const pin = await downloadPinterestMedia(pinUrl);
            if (pin.kind === 'video') {
              try {
                await sendVideoAsSoundSticker(sock, jid, pin.buffer, {
                  quoted: msg,
                  startSeconds,
                  ffmpegPath,
                  ffprobePath,
                });
                pushLog(`✅ [${rec.name}] Sound sticker Pinterest terkirim ke ${normalizeUser(jid)}`);
                convertVideoToSoundSticker(pin.buffer, { startSeconds, ffmpegPath, ffprobePath })
                  .then((conv) =>
                    archiveCreatedSticker({
                      stickerBuffer: conv.sticker,
                      audioBuffer: conv.audio,
                      seconds: conv.seconds,
                      source: 'Pinterest WA',
                      name: pin.title,
                    })
                  )
                  .catch(() => {});
              } catch (soundErr) {
                // Jika video Pinterest tidak memiliki audio, otomatis buat Stiker Animasi tanpa suara
                if (soundErr?.code === 'NO_AUDIO' || soundErr?.code === 'SILENT_AUDIO') {
                  const conv = await convertMediaToWebpSticker(pin.buffer, {
                    isAnimated: true,
                    startSeconds,
                  });
                  await sock.sendMessage(jid, { sticker: conv.sticker }, { quoted: msg });
                  pushLog(`✅ [${rec.name}] Stiker animasi Pinterest (tanpa suara) terkirim ke ${normalizeUser(jid)}`);
                  archiveCreatedSticker({
                    stickerBuffer: conv.sticker,
                    audioBuffer: null,
                    seconds: 0,
                    source: 'Pinterest WA',
                    name: pin.title,
                  }).catch(() => {});
                } else {
                  throw soundErr;
                }
              }
            } else {
              const conv = await convertMediaToWebpSticker(pin.buffer, {
                isAnimated: pin.isGif,
                isGif: pin.isGif,
              });
              await sock.sendMessage(jid, { sticker: conv.sticker }, { quoted: msg });
              pushLog(`✅ [${rec.name}] Stiker gambar Pinterest terkirim ke ${normalizeUser(jid)}`);
              archiveCreatedSticker({
                stickerBuffer: conv.sticker,
                audioBuffer: null,
                seconds: 0,
                source: 'Pinterest WA',
                name: pin.title,
              }).catch(() => {});
            }
          } catch (err) {
            pushLog(`❌ [${rec.name}] .pinsticker gagal: ${err?.message || err}`);
            await sock.sendMessage(
              jid,
              { text: `❌ Gagal ekstrak Pinterest: ${err?.message || err}` },
              { quoted: msg }
            );
          }
          continue;
        }

        if (cmd === '.gantisuara') {
          try {
            const videoBuffer = await downloadVideoForSoundSticker(msg);
            const senderKey = `${rec.id}::${jid}::${msg.key.fromMe ? 'self' : msg.key.participant || jid}`;
            pendingCustomAudio.set(senderKey, {
              videoBuffer,
              expiresAt: Date.now() + 2 * 60 * 1000,
            });
            await sock.sendMessage(
              jid,
              {
                text: '🎬 *Video diterima!* Sekarang kirim *Voice Note* atau *file audio* (MP3/WAV/M4A) dalam 2 menit sebagai suara penggantinya.',
              },
              { quoted: msg }
            );
            pushLog(`🎧 [${rec.name}] .gantisuara menunggu audio pengganti dari ${normalizeUser(jid)}`);
          } catch (err) {
            await sock.sendMessage(
              jid,
              {
                text: `⚠️ Kirim atau reply video MP4/MOV dengan \`.gantisuara\` terlebih dahulu. (${err?.message || err})`,
              },
              { quoted: msg }
            );
          }
          continue;
        }

        // Cek apakah pesan ini menyelesaikan langkah ke-2 dari .gantisuara (mengirim VN/file audio)
        const unwrapped = unwrapWaMessage(msg.message);
        const senderKey = `${rec.id}::${jid}::${msg.key.fromMe ? 'self' : msg.key.participant || jid}`;
        const pending = pendingCustomAudio.get(senderKey);
        if (pending && Date.now() <= pending.expiresAt && hasAudioPayload(unwrapped)) {
          pendingCustomAudio.delete(senderKey);
          await sock.sendMessage(
            jid,
            { text: '⏳ Menggabungkan video dengan suara pilihan Anda & membuat sticker...' },
            { quoted: msg }
          );
          try {
            const audioBuffer = await downloadMediaMessage(
              { key: msg.key, message: unwrapped },
              'buffer',
              {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );
            const mime =
              unwrapped.audioMessage?.mimetype || unwrapped.documentMessage?.mimetype || 'audio/ogg';
            const fileName = unwrapped.documentMessage?.fileName || '';
            const mergedVideo = await mergeVideoWithCustomAudio(
              pending.videoBuffer,
              audioBuffer,
              guessAudioExtFromMime(mime, fileName)
            );
            await sendVideoAsSoundSticker(sock, jid, mergedVideo, {
              quoted: msg,
              ffmpegPath,
              ffprobePath,
            });
            pushLog(`✅ [${rec.name}] Sound sticker suara kustom terkirim ke ${normalizeUser(jid)}`);
            convertVideoToSoundSticker(mergedVideo, { ffmpegPath, ffprobePath })
              .then((conv) =>
                archiveCreatedSticker({
                  stickerBuffer: conv.sticker,
                  audioBuffer: conv.audio,
                  seconds: conv.seconds,
                  source: `WA Ganti Suara`,
                  name: `Stiker Kustom ${new Date().toLocaleTimeString('id-ID', { hour12: false })}`,
                })
              )
              .catch(() => {});
          } catch (err) {
            pushLog(`❌ [${rec.name}] .gantisuara gagal: ${err?.message || err}`);
            await sock.sendMessage(
              jid,
              { text: `❌ Gagal mengganti suara sticker: ${err?.message || err}` },
              { quoted: msg }
            );
          }
          continue;
        }

        if (cmd === '.sticker') {
          await sock.sendMessage(jid, { text: 'Sedang membuat sticker...' }, { quoted: msg });
          pushLog(`🎬 [${rec.name}] Memproses .Sticker dari ${normalizeUser(jid)}...`);
          try {
            const videoBuffer = await downloadVideoForSoundSticker(msg);
            await sendVideoAsSoundSticker(sock, jid, videoBuffer, {
              quoted: msg,
              ffmpegPath,
              ffprobePath,
            });
            pushLog(`✅ [${rec.name}] Sound sticker (24 FPS) terkirim ke ${normalizeUser(jid)}`);
            // Arsipkan ke galeri "Hasil Stiker yang Telah Dibuat" di latar belakang agar balasan WA tetap cepat
            convertVideoToSoundSticker(videoBuffer, { ffmpegPath, ffprobePath })
              .then((conv) =>
                archiveCreatedSticker({
                  stickerBuffer: conv.sticker,
                  audioBuffer: conv.audio,
                  seconds: conv.seconds,
                  source: `WA (${rec.name})`,
                  name: `Stiker WA ${new Date().toLocaleTimeString('id-ID', { hour12: false })}`,
                })
              )
              .catch(() => {});
          } catch (err) {
            pushLog(`❌ [${rec.name}] .Sticker gagal: ${err?.message || err}`);
            await sock.sendMessage(
              jid,
              { text: `❌ Gagal membuat sticker bersuara: ${err?.message || err}` },
              { quoted: msg }
            );
          }
        }
      } catch (err) {
        console.error(`⚠️ [${rec.name}] Error memproses pesan:`, err?.message || err);
      }
    }
  });
}

async function initSessions() {
  await fs.mkdir(AUTH_ROOT_DIR, { recursive: true });
  const saved = await loadRegistry();
  const entries = Object.values(saved);

  if (entries.length === 0) {
    // Pertahankan sesi lama di folder auth/ jika sudah pernah pairing
    const rec = createRecord({
      id: 'utama',
      name: 'Nomor Utama',
      authDir: AUTH_ROOT_DIR,
    });
    sessions.set(rec.id, rec);
    await saveRegistry();
  } else {
    for (const item of entries) {
      if (!item?.id) continue;
      const rec = createRecord({
        id: item.id,
        name: item.name,
        authDir: item.authDir || path.join(AUTH_ROOT_DIR, item.id),
        createdAt: item.createdAt,
      });
      sessions.set(rec.id, rec);
    }
  }

  for (const rec of sessions.values()) {
    connectSession(rec.id).catch((err) => {
      console.error(`⚠️ Gagal menyambungkan ${rec.name}:`, err.message);
    });
  }
}

function startWebApp() {
  const app = express();
  app.use(express.json());
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  app.get('/api/status', (_req, res) => {
    res.json(getStatusSnapshot());
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sseClients.add(send);
    send('status', getStatusSnapshot());

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(send);
    });
  });

  // Tambah nomor baru (+ opsional langsung minta Pairing Code dalam 1 langkah)
  app.post('/api/sessions', async (req, res) => {
    try {
      if (sessions.size >= MAX_SESSIONS) {
        return res.status(400).json({ error: `Maksimal ${MAX_SESSIONS} nomor aktif bersamaan.` });
      }
      const cleanName =
        String(req.body?.name || '').trim().slice(0, 40) || `Nomor #${sessions.size + 1}`;
      const rawPhone = String(req.body?.phone || '').trim();
      const id = `wa_${crypto.randomBytes(3).toString('hex')}`;
      const authDir = path.join(AUTH_ROOT_DIR, id);

      const rec = createRecord({ id, name: cleanName, authDir });
      sessions.set(id, rec);
      await saveRegistry();
      pushLog(`➕ Sesi baru "${cleanName}" dibuat.`);

      await connectSession(id);

      let code = null;
      if (rawPhone) {
        code = await requestPairingForSession(id, rawPhone);
      }

      res.status(201).json({
        ok: true,
        session: serializeSession(rec),
        code,
      });
    } catch (err) {
      const msg = err?.message || 'Gagal menambah nomor.';
      pushLog(`❌ Tambah nomor gagal: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  // Minta Pairing Code untuk sesi tertentu
  app.post('/api/sessions/:id/pairing', async (req, res) => {
    try {
      const code = await requestPairingForSession(req.params.id, req.body?.phone);
      res.json({ ok: true, code });
    } catch (err) {
      const msg = err?.message || 'Gagal meminta pairing code.';
      pushLog(`❌ Pairing gagal: ${msg}`);
      res.status(400).json({ error: msg });
    }
  });

  // Lepas pairing / reset sesi tertentu
  app.post('/api/sessions/:id/reset', async (req, res) => {
    try {
      const session = await resetSession(req.params.id);
      res.json({ ok: true, session });
    } catch (err) {
      res.status(400).json({ error: err?.message || 'Gagal mereset sesi.' });
    }
  });

  // Hapus nomor / sesi tertentu
  app.delete('/api/sessions/:id', async (req, res) => {
    try {
      const result = await deleteSession(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err?.message || 'Gagal menghapus sesi.' });
    }
  });

  app.get('/api/created-stickers', (_req, res) => {
    res.json({ stickers: createdStickers });
  });

  app.get('/api/created-stickers/:id/webp', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^stk_[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const fullPath = path.join(STICKERS_DIR, `${id}.webp`);
    try {
      await fs.access(fullPath);
      res.setHeader('Content-Type', 'image/webp');
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'File stiker tidak ditemukan.' });
    }
  });

  app.get('/api/created-stickers/:id/ogg', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^stk_[a-z0-9_]+$/.test(id)) return res.status(400).json({ error: 'ID tidak valid.' });
    const fullPath = path.join(SOUNDS_DIR, `${id}.ogg`);
    try {
      await fs.access(fullPath);
      res.setHeader('Content-Type', 'audio/ogg');
      res.sendFile(fullPath);
    } catch {
      res.status(404).json({ error: 'File audio tidak ditemukan.' });
    }
  });

  app.delete('/api/created-stickers/:id', async (req, res) => {
    const ok = await removeCreatedSticker(String(req.params.id || ''));
    if (!ok) return res.status(404).json({ error: 'Stiker tidak ditemukan.' });
    res.json({ deleted: true });
  });

  // Ekstrak video dari link TikTok -> Sound Sticker (24 FPS, maks. 15 detik) & opsional kirim ke WhatsApp
  app.post('/api/tiktok-sticker', async (req, res) => {
    try {
      const rawUrl = String(req.body?.url || '').trim();
      const ttUrl = extractTikTokUrl(rawUrl) || rawUrl;
      if (!ttUrl) {
        return res.status(400).json({ error: 'Masukkan link video TikTok terlebih dahulu.' });
      }

      const rawStart = Number(req.body?.startSeconds ?? 0);
      const startSeconds =
        Number.isFinite(rawStart) && rawStart >= 0 && rawStart <= 3600 ? rawStart : 0;

      const targetMode = String(req.body?.targetMode || 'preview').trim();
      const targetPhone = formatIndonesianPhone(req.body?.phone);
      const requestedSessionId = String(req.body?.sessionId || '').trim();

      const tt = await downloadTikTokVideo(ttUrl);
      const converted = await convertVideoToSoundSticker(tt.buffer, {
        startSeconds,
        ffmpegPath,
        ffprobePath,
      });

      let sentTo = null;
      if (targetMode === 'self' || targetMode === 'phone') {
        const activeSession =
          (requestedSessionId && sessions.get(requestedSessionId)) ||
          [...sessions.values()].find((s) => s.status === 'open' && s.sock?.user?.id);

        if (!activeSession || activeSession.status !== 'open' || !activeSession.sock?.user?.id) {
          return res.status(400).json({
            error: 'Belum ada nomor WhatsApp yang terhubung. Pairing nomor terlebih dahulu.',
          });
        }

        let targetJid = '';
        if (targetMode === 'self') {
          targetJid = `${normalizeUser(activeSession.sock.user.id)}@s.whatsapp.net`;
        } else {
          if (targetPhone.length < 10 || targetPhone.length > 16) {
            return res.status(400).json({
              error: 'Masukkan nomor WhatsApp tujuan yang valid (10–16 digit).',
            });
          }
          targetJid = `${targetPhone}@s.whatsapp.net`;
        }

        await sendVideoAsSoundSticker(activeSession.sock, targetJid, tt.buffer, {
          startSeconds,
          ffmpegPath,
          ffprobePath,
        });
        sentTo = normalizeUser(targetJid);
        pushLog(`🎵 [${activeSession.name}] Sound sticker TikTok dikirim dari Web ke ${sentTo}`);
      } else {
        pushLog(`🎵 Sound sticker TikTok dibuat di Web Studio (${tt.title})`);
      }

      const archived = await archiveCreatedSticker({
        stickerBuffer: converted.sticker,
        audioBuffer: converted.audio,
        seconds: converted.seconds,
        source: sentTo ? `TikTok → ${sentTo}` : 'TikTok Web',
        name: tt.title,
      });

      res.json({
        ok: true,
        sentTo,
        sticker: archived,
      });
    } catch (err) {
      res.status(400).json({ error: err?.message || 'Gagal memproses link TikTok.' });
    }
  });

  // Ekstrak video / gambar dari link Pinterest -> Sound Sticker / Sticker & opsional kirim ke WhatsApp
  app.post('/api/pinterest-sticker', async (req, res) => {
    try {
      const rawUrl = String(req.body?.url || '').trim();
      const pinUrl = extractPinterestUrl(rawUrl) || rawUrl;
      if (!pinUrl) {
        return res.status(400).json({ error: 'Masukkan link Pinterest terlebih dahulu.' });
      }

      const rawStart = Number(req.body?.startSeconds ?? 0);
      const startSeconds =
        Number.isFinite(rawStart) && rawStart >= 0 && rawStart <= 3600 ? rawStart : 0;

      const targetMode = String(req.body?.targetMode || 'preview').trim();
      const targetPhone = formatIndonesianPhone(req.body?.phone);
      const requestedSessionId = String(req.body?.sessionId || '').trim();

      const pin = await downloadPinterestMedia(pinUrl);
      let stickerBuffer = null;
      let audioBuffer = null;
      let seconds = 0;
      let isSoundSticker = false;

      if (pin.kind === 'video') {
        try {
          const conv = await convertVideoToSoundSticker(pin.buffer, {
            startSeconds,
            ffmpegPath,
            ffprobePath,
          });
          stickerBuffer = conv.sticker;
          audioBuffer = conv.audio;
          seconds = conv.seconds;
          isSoundSticker = true;
        } catch (soundErr) {
          if (soundErr?.code === 'NO_AUDIO' || soundErr?.code === 'SILENT_AUDIO') {
            const conv = await convertMediaToWebpSticker(pin.buffer, {
              isAnimated: true,
              startSeconds,
            });
            stickerBuffer = conv.sticker;
          } else {
            throw soundErr;
          }
        }
      } else {
        const conv = await convertMediaToWebpSticker(pin.buffer, {
          isAnimated: pin.isGif,
          isGif: pin.isGif,
        });
        stickerBuffer = conv.sticker;
      }

      let sentTo = null;
      if (targetMode === 'self' || targetMode === 'phone') {
        const activeSession =
          (requestedSessionId && sessions.get(requestedSessionId)) ||
          [...sessions.values()].find((s) => s.status === 'open' && s.sock?.user?.id);

        if (!activeSession || activeSession.status !== 'open' || !activeSession.sock?.user?.id) {
          return res.status(400).json({
            error: 'Belum ada nomor WhatsApp yang terhubung. Pairing nomor terlebih dahulu.',
          });
        }

        let targetJid = '';
        if (targetMode === 'self') {
          targetJid = `${normalizeUser(activeSession.sock.user.id)}@s.whatsapp.net`;
        } else {
          if (targetPhone.length < 10 || targetPhone.length > 16) {
            return res.status(400).json({
              error: 'Masukkan nomor WhatsApp tujuan yang valid (10–16 digit).',
            });
          }
          targetJid = `${targetPhone}@s.whatsapp.net`;
        }

        if (isSoundSticker) {
          await sendVideoAsSoundSticker(activeSession.sock, targetJid, pin.buffer, {
            startSeconds,
            ffmpegPath,
            ffprobePath,
          });
        } else {
          await activeSession.sock.sendMessage(targetJid, { sticker: stickerBuffer });
        }

        sentTo = normalizeUser(targetJid);
        pushLog(`📌 [${activeSession.name}] Stiker Pinterest dikirim dari Web ke ${sentTo}`);
      } else {
        pushLog(`📌 Stiker Pinterest dibuat di Web Studio (${pin.title})`);
      }

      const archived = await archiveCreatedSticker({
        stickerBuffer,
        audioBuffer,
        seconds,
        source: sentTo ? `Pinterest → ${sentTo}` : 'Pinterest Web',
        name: pin.title,
      });

      res.json({
        ok: true,
        sentTo,
        isSoundSticker,
        sticker: archived,
      });
    } catch (err) {
      res.status(400).json({ error: err?.message || 'Gagal memproses link Pinterest.' });
    }
  });

  // Konversi video -> sound sticker (mendukung opsional ganti suara dengan audio upload / rekaman mikrofon)
  app.post(
    '/api/sound-sticker',
    upload.fields([
      { name: 'video', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const videoFile = req.files?.video?.[0];
        const customAudioFile = req.files?.audio?.[0];

        if (!videoFile?.buffer?.length) {
          return res.status(400).json({ error: 'Unggah file video MP4/MOV terlebih dahulu.' });
        }

        const targetMode = String(req.body?.targetMode || 'preview').trim();
        const targetPhone = formatIndonesianPhone(req.body?.phone);
        const requestedSessionId = String(req.body?.sessionId || '').trim();

        // Jika pengguna melampirkan audio kustom / rekaman suara, gabungkan ke video terlebih dahulu
        let sourceVideoBuffer = videoFile.buffer;
        if (customAudioFile?.buffer?.length) {
          const ext = guessAudioExtFromMime(customAudioFile.mimetype, customAudioFile.originalname);
          sourceVideoBuffer = await mergeVideoWithCustomAudio(
            videoFile.buffer,
            customAudioFile.buffer,
            ext
          );
        }

        const converted = await convertVideoToSoundSticker(sourceVideoBuffer, {
          ffmpegPath,
          ffprobePath,
        });

        let sentTo = null;
        if (targetMode === 'self' || targetMode === 'phone') {
          const activeSession =
            (requestedSessionId && sessions.get(requestedSessionId)) ||
            [...sessions.values()].find((s) => s.status === 'open' && s.sock?.user?.id);

          if (!activeSession || activeSession.status !== 'open' || !activeSession.sock?.user?.id) {
            return res.status(400).json({
              error: 'Belum ada nomor WhatsApp yang terhubung. Pairing nomor terlebih dahulu.',
            });
          }

          let targetJid = '';
          if (targetMode === 'self') {
            targetJid = `${normalizeUser(activeSession.sock.user.id)}@s.whatsapp.net`;
          } else {
            if (targetPhone.length < 10 || targetPhone.length > 16) {
              return res.status(400).json({
                error: 'Masukkan nomor WhatsApp tujuan yang valid (10–16 digit).',
              });
            }
            targetJid = `${targetPhone}@s.whatsapp.net`;
          }

          await sendVideoAsSoundSticker(activeSession.sock, targetJid, sourceVideoBuffer, {
            ffmpegPath,
            ffprobePath,
          });
          sentTo = normalizeUser(targetJid);
          pushLog(
            `🌐 [${activeSession.name}] Sound sticker${customAudioFile ? ' (suara kustom)' : ''} dikirim ke ${sentTo}`
          );
        } else {
          pushLog(`🌐 Sound sticker${customAudioFile ? ' (suara kustom)' : ''} dibuat di Web Studio`);
        }

        const archived = await archiveCreatedSticker({
          stickerBuffer: converted.sticker,
          audioBuffer: converted.audio,
          seconds: converted.seconds,
          source: customAudioFile
            ? sentTo
              ? `Kustom → ${sentTo}`
              : 'Web Kustom'
            : sentTo
              ? `Web → ${sentTo}`
              : 'Web',
          name: videoFile.originalname?.replace(/\.[^.]+$/, '') || undefined,
        });

        res.json({
          ok: true,
          sentTo,
          sticker: archived,
        });
      } catch (err) {
        res.status(400).json({ error: err?.message || 'Gagal mengonversi video.' });
      }
    }
  );

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload gagal: ${err.message}` });
    }
    res.status(500).json({ error: err?.message || 'Terjadi kesalahan server.' });
  });

  const server = app.listen(WEB_PORT, WEB_HOST, () => {
    const lanUrls = getLanAddresses(WEB_PORT);
    console.log('🌐 Aplikasi Web (PWA · Multi-Nomor Pairing HP) aktif di:');
    console.log(`   • Lokal : http://localhost:${WEB_PORT}`);
    for (const url of lanUrls) {
      console.log(`   • Wi-Fi / LAN : ${url}`);
    }
    console.log(
      `   • Publik (Internet): cloudflared tunnel --url http://localhost:${WEB_PORT}\n`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `❌ Port ${WEB_PORT} sudah dipakai oleh proses lain! Tutup jendela bot lama atau jalankan dengan PORT lain.`
      );
      process.exit(1);
    }
    console.error('❌ Error Web App:', err.message);
  });

  return server;
}

process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection:', err?.message || err);
});

printStartupBanner();
await loadCreatedStickers();
startWebApp();
initSessions().catch((err) => {
  console.error('❌ Gagal menginisialisasi sesi bot:', err);
  process.exit(1);
});
