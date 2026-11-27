const els = {
  statusPill: document.getElementById('status-pill'),
  statusLabel: document.getElementById('status-label'),
  statActive: document.getElementById('stat-active'),
  statTotal: document.getElementById('stat-total'),
  statStickers: document.getElementById('stat-stickers'),
  statPings: document.getElementById('stat-pings'),
  addSessionForm: document.getElementById('add-session-form'),
  newSessionName: document.getElementById('new-session-name'),
  newSessionPhone: document.getElementById('new-session-phone'),
  addSessionBtn: document.getElementById('add-session-btn'),
  sessionsGrid: document.getElementById('sessions-grid'),
  convertForm: document.getElementById('convert-form'),
  sourceTabs: document.querySelectorAll('[data-source-tab]'),
  uploadSourceGroup: document.getElementById('upload-source-group'),
  tiktokSourceGroup: document.getElementById('tiktok-source-group'),
  tiktokUrlInput: document.getElementById('tiktok-url-input'),
  tiktokStartInput: document.getElementById('tiktok-start-input'),
  pinterestSourceGroup: document.getElementById('pinterest-source-group'),
  pinterestUrlInput: document.getElementById('pinterest-url-input'),
  pinterestStartInput: document.getElementById('pinterest-start-input'),
  videoInput: document.getElementById('video-input'),
  customAudioInput: document.getElementById('custom-audio-input'),
  recordBtn: document.getElementById('record-btn'),
  recordStatus: document.getElementById('record-status'),
  clearRecordBtn: document.getElementById('clear-record-btn'),
  recordPreview: document.getElementById('record-preview'),
  greenScreenMode: document.getElementById('greenscreen-mode'),
  targetMode: document.getElementById('target-mode'),
  senderGroup: document.getElementById('sender-group'),
  senderSession: document.getElementById('sender-session'),
  phoneGroup: document.getElementById('phone-group'),
  targetPhone: document.getElementById('target-phone'),
  convertBtn: document.getElementById('convert-btn'),
  galleryCount: document.getElementById('gallery-count'),
  galleryEmpty: document.getElementById('gallery-empty'),
  galleryList: document.getElementById('gallery-list'),
  activityLog: document.getElementById('activity-log'),
  accessInfo: document.getElementById('access-info'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmDesc: document.getElementById('confirm-desc'),
  confirmOk: document.getElementById('confirm-ok'),
  installBtn: document.getElementById('install-btn'),
  iosInstallDialog: document.getElementById('ios-install-dialog'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;
let pendingConfirmAction = null;
let activeSourceTab = 'upload'; // 'upload' | 'tiktok'
let recordedBlob = null;
let mediaRecorder = null;
let recordChunks = [];
let recordTimer = null;
let recordSeconds = 0;

function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast toast-${type}`;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4000);
}

function openConfirm({ title, desc, okLabel = 'Lanjutkan', onConfirm }) {
  els.confirmTitle.textContent = title;
  els.confirmDesc.textContent = desc;
  els.confirmOk.textContent = okLabel;
  pendingConfirmAction = onConfirm;
  els.confirmDialog.showModal();
}

els.confirmDialog.addEventListener('close', async () => {
  const val = els.confirmDialog.returnValue;
  els.confirmDialog.returnValue = '';
  const fn = pendingConfirmAction;
  pendingConfirmAction = null;
  if (val === 'confirm' && typeof fn === 'function') {
    await fn();
  }
});

/* --- Fallback light-dismiss <dialog closedby="any"> --- */
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const isOutside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e, dialog)) dialog.close();
    });
  }
}

function getStatusPillMeta(status) {
  if (status === 'open') return { cls: 'pill pill-online', text: 'Terhubung' };
  if (status === 'pairing') return { cls: 'pill pill-qr', text: 'Siap Pairing HP' };
  if (status === 'close') return { cls: 'pill pill-offline', text: 'Terputus' };
  return { cls: 'pill', text: 'Menghubungkan...' };
}

function renderLogs(logs = []) {
  els.activityLog.innerHTML = '';
  if (!logs.length) {
    els.activityLog.innerHTML = '<p class="muted">Menunggu aktivitas bot...</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of logs) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `[${item.time}]`;
    const msg = document.createElement('span');
    msg.textContent = item.message;
    row.append(time, msg);
    frag.append(row);
  }
  els.activityLog.append(frag);
}

function renderSenderOptions(sessions = []) {
  const prev = els.senderSession.value;
  els.senderSession.innerHTML = '';
  const active = sessions.filter((s) => s.status === 'open');
  if (active.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Belum ada nomor terhubung';
    els.senderSession.append(opt);
    return;
  }
  for (const s of active) {
    const opt = document.createElement('option');
    opt.value = s.id;
    const num = s.user?.id ? s.user.id.split(':')[0] : '';
    opt.textContent = num ? `${s.name} (${num})` : s.name;
    els.senderSession.append(opt);
  }
  if (active.some((s) => s.id === prev)) {
    els.senderSession.value = prev;
  }
}

function renderSessions(sessions = []) {
  // Simpan nilai input nomor HP yang sedang diketik user agar tidak hilang saat SSE refresh
  const draftPhones = new Map();
  els.sessionsGrid.querySelectorAll('input[data-session-phone]').forEach((inp) => {
    draftPhones.set(inp.dataset.sessionPhone, inp.value);
  });

  els.sessionsGrid.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'card empty-state';
    empty.style.gridColumn = '1 / -1';
    empty.innerHTML = '<p>Belum ada nomor terdaftar. Tambahkan nomor HP di atas untuk mulai pairing!</p>';
    els.sessionsGrid.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const s of sessions) {
    const card = document.createElement('article');
    card.className = 'card session-card';

    // Top row
    const top = document.createElement('div');
    top.className = 'session-top';

    const titleBox = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'session-name';
    title.textContent = s.name;
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.innerHTML = `ID: <code>${s.id}</code>`;
    titleBox.append(title, meta);

    const sm = getStatusPillMeta(s.status);
    const pill = document.createElement('span');
    pill.className = sm.cls;
    pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${sm.text}</span>`;
    top.append(titleBox, pill);
    card.append(top);

    // Body: Connected OR Phone Pairing Form
    if (s.status === 'open') {
      const box = document.createElement('div');
      box.className = 'session-connected';
      const num = s.user?.id ? s.user.id.split(':')[0] : '';
      box.innerHTML = `
        <span style="font-size:1.45rem" aria-hidden="true">✅</span>
        <div>
          <strong style="color:#5eead4;display:block">${s.user?.name || 'WhatsApp Terhubung'}</strong>
          <span class="muted">${num || 'Aktif menerima .menu, .ping, .Sticker'}</span>
        </div>
      `;
      card.append(box);
    } else {
      const pairForm = document.createElement('form');
      pairForm.className = 'form-stack';
      pairForm.noValidate = true;

      const row = document.createElement('div');
      row.className = 'pairing-inline';

      const phoneInp = document.createElement('input');
      phoneInp.type = 'tel';
      phoneInp.placeholder = '081234567890 / 62812...';
      phoneInp.dataset.sessionPhone = s.id;
      phoneInp.value = draftPhones.get(s.id) ?? s.lastPairingPhone ?? '';

      const pairBtn = document.createElement('button');
      pairBtn.type = 'submit';
      pairBtn.className = 'btn btn-primary btn-sm';
      pairBtn.textContent = 'Minta Kode';

      const codeBox = document.createElement('div');
      codeBox.className = 'pairing-code-box';
      if (s.lastPairingCode) {
        codeBox.innerHTML = `Kode Pairing: <strong>${s.lastPairingCode}</strong>`;
        codeBox.hidden = false;
      } else {
        codeBox.hidden = true;
      }

      pairForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cleaned = phoneInp.value.replace(/\D/g, '');
        if (cleaned.length < 10 || cleaned.length > 16) {
          showToast('Masukkan nomor WhatsApp yang valid (10–16 digit).', 'error');
          phoneInp.focus();
          return;
        }
        pairBtn.disabled = true;
        pairBtn.textContent = 'Meminta...';
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/pairing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: cleaned }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Gagal meminta pairing code.');
          codeBox.innerHTML = `Kode Pairing: <strong>${body.code}</strong>`;
          codeBox.hidden = false;
          showToast(`🔑 Kode pairing untuk "${s.name}": ${body.code}`);
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          pairBtn.disabled = false;
          pairBtn.textContent = 'Minta Kode';
        }
      });

      row.append(phoneInp, pairBtn);
      pairForm.append(row, codeBox);
      card.append(pairForm);
    }

    // Footer actions
    const footer = document.createElement('div');
    footer.className = 'session-footer';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-secondary btn-sm';
    resetBtn.textContent = s.status === 'open' ? '🔌 Lepas Pairing' : '🔄 Reset Sesi';
    resetBtn.addEventListener('click', () => {
      const doReset = async () => {
        resetBtn.disabled = true;
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/reset`, {
            method: 'POST',
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Gagal mereset sesi.');
          showToast(`🔄 Sesi "${s.name}" direset.`);
        } catch (err) {
          showToast(err.message, 'error');
          resetBtn.disabled = false;
        }
      };

      if (s.status === 'open') {
        openConfirm({
          title: `Lepas pairing "${s.name}"?`,
          desc: 'Akun WhatsApp pada nomor ini akan di-logout agar bisa pairing ulang dengan nomor HP.',
          okLabel: 'Ya, Lepas Pairing',
          onConfirm: doReset,
        });
      } else {
        doReset();
      }
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost';
    delBtn.style.color = '#fca5a5';
    delBtn.textContent = '🗑️ Hapus Nomor';
    delBtn.addEventListener('click', () => {
      openConfirm({
        title: `Hapus "${s.name}"?`,
        desc: 'Sesi nomor ini akan dimatikan dan folder autentikasinya dihapus permanen.',
        okLabel: 'Ya, Hapus',
        onConfirm: async () => {
          try {
            const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, {
              method: 'DELETE',
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || 'Gagal menghapus sesi.');
            showToast(`🗑️ "${s.name}" dihapus.`);
          } catch (err) {
            showToast(err.message, 'error');
          }
        },
      });
    });

    footer.append(resetBtn, delBtn);
    card.append(footer);
    frag.append(card);
  }

  els.sessionsGrid.append(frag);
}

function renderStatus(data) {
  els.statusPill.className = data.activeCount > 0 ? 'pill pill-online' : 'pill pill-qr';
  els.statusLabel.textContent = `${data.activeCount}/${data.totalCount} Nomor Aktif`;
  els.statActive.textContent = String(data.activeCount ?? 0);
  els.statTotal.textContent = `dari ${data.totalCount ?? 0} nomor terdaftar`;
  els.statStickers.textContent = String(data.stats?.stickersCreated ?? 0);
  els.statPings.textContent = String(data.stats?.pingsHandled ?? 0);

  if (data.lanUrls?.length) {
    els.accessInfo.textContent = `Akses Wi-Fi/LAN: ${data.lanUrls[0]}`;
  }

  renderSessions(data.sessions || []);
  renderSenderOptions(data.sessions || []);
  renderLogs(data.logs || []);
}

/* --- Tambah Nomor Baru (+ langsung minta kode jika nomor diisi) --- */
els.addSessionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.newSessionName.value.trim();
  const phone = els.newSessionPhone.value.replace(/\D/g, '');

  if (!name) {
    showToast('Masukkan nama akun/nomor terlebih dahulu.', 'error');
    els.newSessionName.focus();
    return;
  }
  if (phone && (phone.length < 10 || phone.length > 16)) {
    showToast('Format nomor HP tidak valid (harus 10–16 digit).', 'error');
    els.newSessionPhone.focus();
    return;
  }

  els.addSessionBtn.disabled = true;
  els.addSessionBtn.textContent = phone ? 'Menyiapkan Kode...' : 'Menambah...';

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Gagal menambah nomor.');

    els.newSessionName.value = '';
    els.newSessionPhone.value = '';
    showToast(
      body.code
        ? `🔑 "${body.session.name}" dibuat! Kode Pairing: ${body.code}`
        : `➕ "${body.session.name}" ditambahkan! Masukkan nomor HP di kartunya untuk minta kode.`
    );
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    els.addSessionBtn.disabled = false;
    els.addSessionBtn.textContent = '+ Tambah & Pairing Nomor';
  }
});

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso)
    );
  } catch {
    return iso;
  }
}

function renderGallery(stickers = []) {
  els.galleryCount.textContent = `${stickers.length} stiker`;
  els.galleryList.innerHTML = '';

  if (stickers.length === 0) {
    els.galleryEmpty.hidden = false;
    return;
  }

  els.galleryEmpty.hidden = true;
  const frag = document.createDocumentFragment();

  for (const item of stickers) {
    const card = document.createElement('article');
    card.className = 'sticker-item';

    const top = document.createElement('div');
    top.className = 'sticker-top';

    const titleWrap = document.createElement('div');
    const nameEl = document.createElement('h4');
    nameEl.className = 'sticker-name';
    nameEl.textContent = item.name || item.id;
    const hasAudio = Number(item.audioBytes || 0) > 0;
    const subEl = document.createElement('div');
    subEl.className = 'sticker-hash';
    subEl.textContent = hasAudio
      ? `${item.seconds} dtk · ${(item.stickerBytes / 1024).toFixed(0)} KB · ${formatDate(item.createdAt)}`
      : `Stiker · ${(item.stickerBytes / 1024).toFixed(0)} KB · ${formatDate(item.createdAt)}`;
    titleWrap.append(nameEl, subEl);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = item.source || 'Web';
    top.append(titleWrap, badge);

    const thumb = document.createElement('img');
    thumb.className = 'sticker-thumb';
    thumb.loading = 'lazy';
    thumb.alt = item.name || 'Sound Sticker';
    thumb.src = `/api/created-stickers/${encodeURIComponent(item.id)}/webp`;

    let audio = null;
    if (hasAudio) {
      audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = `/api/created-stickers/${encodeURIComponent(item.id)}/ogg`;
    }

    const actions = document.createElement('div');
    actions.className = 'sticker-actions';

    const dlWebp = document.createElement('a');
    dlWebp.className = 'btn btn-ghost';
    dlWebp.href = `/api/created-stickers/${encodeURIComponent(item.id)}/webp`;
    dlWebp.download = `${item.name || item.id}.webp`;
    dlWebp.textContent = '⬇️ .webp';

    actions.append(dlWebp);

    if (hasAudio) {
      const dlOgg = document.createElement('a');
      dlOgg.className = 'btn btn-ghost';
      dlOgg.href = `/api/created-stickers/${encodeURIComponent(item.id)}/ogg`;
      dlOgg.download = `${item.name || item.id}.ogg`;
      dlOgg.textContent = '⬇️ .ogg';
      actions.append(dlOgg);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-ghost';
    delBtn.style.color = '#fca5a5';
    delBtn.textContent = '🗑️ Hapus';
    delBtn.addEventListener('click', () => {
      openConfirm({
        title: `Hapus "${item.name || item.id}"?`,
        desc: 'Stiker dan file audionya akan dihapus dari galeri.',
        okLabel: 'Ya, Hapus',
        onConfirm: async () => {
          try {
            const res = await fetch(`/api/created-stickers/${encodeURIComponent(item.id)}`, {
              method: 'DELETE',
            });
            if (!res.ok) throw new Error('Gagal menghapus stiker.');
            showToast('🗑️ Stiker dihapus dari galeri.');
            await fetchGallery();
          } catch (err) {
            showToast(err.message, 'error');
          }
        },
      });
    });

    actions.append(delBtn);
    if (audio) card.append(top, thumb, audio, actions);
    else card.append(top, thumb, actions);
    frag.append(card);
  }

  els.galleryList.append(frag);
}

async function fetchGallery() {
  try {
    const res = await fetch('/api/created-stickers');
    if (res.ok) {
      const body = await res.json();
      renderGallery(body.stickers || []);
    }
  } catch {
    // Abaikan jika server offline
  }
}

/* --- Perekam Suara Sendiri (Mikrofon) --- */
function resetRecording() {
  recordedBlob = null;
  els.recordPreview.hidden = true;
  els.recordPreview.removeAttribute('src');
  els.clearRecordBtn.hidden = true;
  els.recordStatus.textContent = 'Pakai suara asli video';
  els.recordBtn.textContent = '🎙️ Rekam Suara Sendiri';
}

els.clearRecordBtn.addEventListener('click', resetRecording);

els.customAudioInput.addEventListener('change', () => {
  if (els.customAudioInput.files?.[0]) {
    resetRecording();
    els.recordStatus.textContent = `Audio: ${els.customAudioInput.files[0].name}`;
  } else {
    els.recordStatus.textContent = 'Pakai suara asli video';
  }
});

els.recordBtn.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('Browser tidak mendukung rekaman mikrofon (butuh HTTPS/localhost).', 'error');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) recordChunks.push(event.data);
    });

    mediaRecorder.addEventListener('stop', () => {
      clearInterval(recordTimer);
      stream.getTracks().forEach((track) => track.stop());
      els.recordBtn.classList.remove('recording');
      els.recordBtn.textContent = '🎙️ Rekam Ulang';

      recordedBlob = new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      els.customAudioInput.value = '';
      els.recordPreview.src = URL.createObjectURL(recordedBlob);
      els.recordPreview.hidden = false;
      els.clearRecordBtn.hidden = false;
      els.recordStatus.textContent = `Rekaman siap (${recordSeconds} dtk)`;
    });

    mediaRecorder.start();
    recordSeconds = 0;
    els.recordBtn.classList.add('recording');
    els.recordBtn.textContent = '⏹️ Berhenti';
    els.recordStatus.textContent = 'Merekam... 0 dtk';
    recordTimer = setInterval(() => {
      recordSeconds += 1;
      els.recordStatus.textContent = `Merekam... ${recordSeconds} dtk`;
    }, 1000);
  } catch (err) {
    showToast(`Izin mikrofon gagal: ${err.message}`, 'error');
  }
});

/* --- Switch Tab Sumber Video (Upload / Link TikTok / Link Pinterest) --- */
els.sourceTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeSourceTab = tab.dataset.sourceTab;
    els.sourceTabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    els.uploadSourceGroup.hidden = activeSourceTab !== 'upload';
    els.tiktokSourceGroup.hidden = activeSourceTab !== 'tiktok';
    els.pinterestSourceGroup.hidden = activeSourceTab !== 'pinterest';
    if (activeSourceTab === 'tiktok') {
      els.convertBtn.textContent = 'Ekstrak TikTok & Buat Stiker';
    } else if (activeSourceTab === 'pinterest') {
      els.convertBtn.textContent = 'Ekstrak Pinterest & Buat Stiker';
    } else {
      els.convertBtn.textContent = 'Konversi Video (24 FPS)';
    }
  });
});

/* --- Form Konversi & Kirim Sound Sticker --- */
els.targetMode.addEventListener('change', () => {
  const mode = els.targetMode.value;
  els.senderGroup.hidden = mode === 'preview';
  els.phoneGroup.hidden = mode !== 'phone';
  els.targetPhone.required = mode === 'phone';
});

els.convertForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (activeSourceTab === 'tiktok') {
    const url = els.tiktokUrlInput.value.trim();
    if (!url) {
      showToast('Tempel link video TikTok terlebih dahulu.', 'error');
      els.tiktokUrlInput.focus();
      return;
    }

    els.convertBtn.disabled = true;
    els.convertBtn.textContent = 'Mengunduh TikTok & Membuat Stiker...';

    try {
      const payload = {
        url,
        startSeconds: Number(els.tiktokStartInput.value || 0) || 0,
        greenScreenMode: els.greenScreenMode?.value || 'auto',
        targetMode: els.targetMode.value,
      };
      if (els.targetMode.value !== 'preview' && els.senderSession.value) {
        payload.sessionId = els.senderSession.value;
      }
      if (els.targetMode.value === 'phone') {
        payload.phone = els.targetPhone.value.replace(/\D/g, '');
      }

      const res = await fetch('/api/tiktok-sticker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Gagal mengekstrak link TikTok.');

      els.tiktokUrlInput.value = '';
      els.tiktokStartInput.value = '0';
      await fetchGallery();
      showToast(
        body.sentTo
          ? `🎵 Sound sticker TikTok berhasil dikirim ke ${body.sentTo}!`
          : '🎵 Sound sticker TikTok berhasil dibuat & masuk galeri!'
      );
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      els.convertBtn.disabled = false;
      els.convertBtn.textContent = 'Ekstrak TikTok & Buat Stiker';
    }
    return;
  }

  if (activeSourceTab === 'pinterest') {
    const url = els.pinterestUrlInput.value.trim();
    if (!url) {
      showToast('Tempel link Pinterest terlebih dahulu.', 'error');
      els.pinterestUrlInput.focus();
      return;
    }

    els.convertBtn.disabled = true;
    els.convertBtn.textContent = 'Mengunduh Pinterest & Membuat Stiker...';

    try {
      const payload = {
        url,
        startSeconds: Number(els.pinterestStartInput.value || 0) || 0,
        greenScreenMode: els.greenScreenMode?.value || 'auto',
        targetMode: els.targetMode.value,
      };
      if (els.targetMode.value !== 'preview' && els.senderSession.value) {
        payload.sessionId = els.senderSession.value;
      }
      if (els.targetMode.value === 'phone') {
        payload.phone = els.targetPhone.value.replace(/\D/g, '');
      }

      const res = await fetch('/api/pinterest-sticker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Gagal mengekstrak link Pinterest.');

      els.pinterestUrlInput.value = '';
      els.pinterestStartInput.value = '0';
      await fetchGallery();
      const label = body.isSoundSticker ? 'Sound sticker Pinterest' : 'Stiker Pinterest';
      showToast(
        body.sentTo
          ? `📌 ${label} berhasil dikirim ke ${body.sentTo}!`
          : `📌 ${label} berhasil dibuat & masuk galeri!`
      );
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      els.convertBtn.disabled = false;
      els.convertBtn.textContent = 'Ekstrak Pinterest & Buat Stiker';
    }
    return;
  }

  const file = els.videoInput.files?.[0];
  if (!file) {
    showToast('Pilih file video MP4/MOV terlebih dahulu.', 'error');
    return;
  }

  const fd = new FormData();
  fd.append('video', file);
  const customAudio = els.customAudioInput.files?.[0];
  if (customAudio) {
    fd.append('audio', customAudio);
  } else if (recordedBlob) {
    fd.append('audio', recordedBlob, 'rekaman-suara.webm');
  }
  fd.append('greenScreenMode', els.greenScreenMode?.value || 'auto');
  fd.append('targetMode', els.targetMode.value);
  if (els.targetMode.value !== 'preview' && els.senderSession.value) {
    fd.append('sessionId', els.senderSession.value);
  }
  if (els.targetMode.value === 'phone') {
    fd.append('phone', els.targetPhone.value.replace(/\D/g, ''));
  }

  els.convertBtn.disabled = true;
  els.convertBtn.textContent =
    customAudio || recordedBlob ? 'Menggabungkan Suara & Membuat Stiker...' : 'Memproses 24 FPS...';

  try {
    const res = await fetch('/api/sound-sticker', { method: 'POST', body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Gagal mengonversi video.');

    els.convertForm.reset();
    resetRecording();
    els.senderGroup.hidden = true;
    els.phoneGroup.hidden = true;
    await fetchGallery();

    showToast(
      body.sentTo
        ? `✅ Sound sticker berhasil dikirim ke ${body.sentTo} & masuk galeri!`
        : '✅ Sound sticker berhasil dibuat & masuk galeri!'
    );
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    els.convertBtn.disabled = false;
    els.convertBtn.textContent = 'Konversi Video (24 FPS)';
  }
});

/* --- Fetch Awal & SSE Live --- */
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) renderStatus(await res.json());
  } catch {
    els.statusPill.className = 'pill pill-offline';
    els.statusLabel.textContent = 'Server Offline';
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener('stickers', (e) => {
    const data = JSON.parse(e.data);
    renderGallery(data.stickers || []);
  });
  es.onerror = () => {
    els.statusPill.className = 'pill pill-offline';
    els.statusLabel.textContent = 'Menghubungkan...';
  };
}

Promise.allSettled([fetchStatus(), fetchGallery()]).then(connectEvents);

/* --- PWA Service Worker & Install App --- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let deferredInstallPrompt = null;
const isStandalone =
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);

if (isIos && !isStandalone) els.installBtn.hidden = false;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  els.installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  els.installBtn.hidden = true;
  showToast('📲 Aplikasi berhasil terpasang!');
});

els.installBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') els.installBtn.hidden = true;
    return;
  }
  if (isIos) els.iosInstallDialog.showModal();
});
