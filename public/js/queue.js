/**
 * Download Queue UI Module
 * Navbar icon with badge + floating popup panel.
 */
(function () {
  'use strict';

  const API = window.location.origin;
  const POLL_MS = 2000;
  const ACTIVE_STATES = ['pending', 'processing', 'playlist'];

  let jobs = [];
  let popupOpen = false;
  let timer = null;

  // ── Playback state ────────────────────────────────────────────────
  let audio = null;        // HTMLAudioElement
  let video = null;        // HTMLVideoElement
  let mediaMode = null;    // 'audio' | 'video' | null
  let playingJobId = null;
  let playingTrack = -1;   // -1 for single, 0+ for playlist index

  // ── DOM refs (set once in init) ──────────────────────────────────
  let badge, popup, listEl, backdrop, videoPanel, videoTitleEl, videoCloseBtn;

  // ── Public API ───────────────────────────────────────────────────

  function initQueue() {
    badge    = document.getElementById('queueBadge');
    popup    = document.getElementById('queuePopup');
    listEl   = document.getElementById('queueItems');
    backdrop = document.getElementById('queueBackdrop');
    videoPanel = document.getElementById('queueVideoPanel');
    videoTitleEl = document.getElementById('queueVideoTitle');
    videoCloseBtn = document.getElementById('queueVideoClose');

    if (!badge || !popup || !listEl) return;

    document.getElementById('queueIcon').addEventListener('click', togglePopup);
    if (backdrop) backdrop.addEventListener('click', closePopup);
    if (videoCloseBtn) videoCloseBtn.addEventListener('click', stopPlayback);
    document.addEventListener('click', onOutsideClick);

    fetchQueue();
    timer = setInterval(fetchQueue, POLL_MS);
  }

  // ── Data ─────────────────────────────────────────────────────────

  async function fetchQueue() {
    try {
      const r = await fetch(`${API}/queue`, { credentials: 'include' });
      if (!r.ok) return;
      const data = await r.json();
      jobs = data.jobs || [];
      updateBadge();
      if (popupOpen) renderQueue();
    } catch (e) {
      console.error('Queue fetch error:', e);
    }
  }

  // ── Badge ────────────────────────────────────────────────────────

  function updateBadge() {
    const count = jobs.filter(j => ACTIVE_STATES.includes(j.status)).length;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Popup toggle ─────────────────────────────────────────────────

  function togglePopup(e) {
    e.stopPropagation();
    if (popupOpen) { closePopup(); } else { openPopup(); }
  }

  function openPopup() {
    popupOpen = true;
    popup.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    renderQueue();
  }

  function closePopup() {
    popupOpen = false;
    popup.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  }

  function onOutsideClick(e) {
    if (!popupOpen) return;
    // If the target was detached from the DOM (e.g., by a render update during
    // a button click), it won't have a parent — don't close in that case.
    if (!e.target.isConnected) return;
    if (e.target.closest('#queuePopup') || e.target.closest('#queueIcon') || e.target.closest('#queueVideoPanel')) return;
    closePopup();
  }

  // ── Render (efficient DOM patching — no flicker) ─────────────────

  function renderQueue() {
    if (!jobs.length) {
      if (!listEl.querySelector('.qp-empty')) {
        listEl.innerHTML = '<div class="qp-empty">Queue is empty</div>';
      }
      return;
    }

    // Remove empty placeholder if present
    const emptyEl = listEl.querySelector('.qp-empty');
    if (emptyEl) emptyEl.remove();

    // Build a map of existing DOM items by job id
    const existing = new Map();
    listEl.querySelectorAll('.qp-item').forEach(el => {
      existing.set(el.dataset.id, el);
    });

    // Track which job ids are still present
    const currentIds = new Set(jobs.map(j => j.id));

    // Remove items no longer in the queue
    existing.forEach((el, id) => {
      if (!currentIds.has(id)) el.remove();
    });

    // Update or create each item in order
    let prevEl = null;
    for (const j of jobs) {
      let el = existing.get(j.id);
      if (el) {
        // Update existing item in-place
        patchItem(el, j);
      } else {
        // Create new item
        el = createItem(j);
      }
      // Ensure correct order
      if (prevEl) {
        if (prevEl.nextElementSibling !== el) {
          prevEl.after(el);
        }
      } else {
        if (listEl.firstElementChild !== el) {
          listEl.prepend(el);
        }
      }
      prevEl = el;
    }
  }

  /** Compute job display data */
  function jobData(j) {
    const isActive  = ACTIVE_STATES.includes(j.status);
    const isDone    = j.status === 'completed';
    const isFailed  = j.status === 'failed';
    const isInterrupted = j.status === 'interrupted';
    const isPlaylist = j.total_videos > 0;
    const trackPct  = j.percent != null ? Math.round(j.percent) : 0;
    const name      = isPlaylist
      ? (j.playlist_title || j.current_title || (j.current_video ? `Loading track ${j.current_video}...` : null) || j.file_name || j.url || j.id)
      : (j.current_title || j.file_name || j.url || j.id);

    let statusText = j.status;
    // Playlist status takes priority — show "Track X/Y" not "Downloading 100%"
    if (j.status === 'playlist' && isPlaylist) {
      statusText = `Track ${j.current_video || 0}/${j.total_videos}`;
    } else if (isActive && j.percent != null) {
      statusText = `Downloading ${trackPct}%`;
    } else if (j.status === 'pending') {
      statusText = 'Queued';
    } else if (isDone) {
      statusText = 'Complete';
    } else if (isFailed) {
      statusText = 'Failed';
    } else if (isInterrupted) {
      statusText = 'Interrupted';
    }

    // For playlists: bar shows overall progress (tracks completed / total)
    // For single tracks: bar shows download percent
    let barPct, barMod = '';
    if (isDone)        { barPct = 100; barMod = ' qp-bar-ok'; }
    else if (isFailed) { barPct = 100; barMod = ' qp-bar-err'; }
    else if (isInterrupted) { barPct = trackPct; barMod = ' qp-bar-err'; }
    else if (isPlaylist && isActive) {
      barPct = Math.round(((j.current_video || 0) / j.total_videos) * 100);
    } else {
      barPct = trackPct;
    }

    const meta = [];
    if (isActive && j.speed) meta.push(esc(j.speed));
    if (isActive && j.eta)   meta.push('ETA ' + esc(j.eta));
    if (j.file_size)         meta.push(esc(j.file_size));

    return { isActive, isDone, isFailed, isInterrupted, isPlaylist, name, statusText, barPct, barMod, meta };
  }

  /** Create a new DOM element for a job */
  function createItem(j) {
    const d = jobData(j);
    const el = document.createElement('div');
    el.className = 'qp-item';
    el.dataset.id = j.id;
    el.innerHTML = buildItemHTML(j, d);
    bindActions(el, j);
    return el;
  }

  /** Patch an existing DOM element with updated job data */
  function patchItem(el, j) {
    const d = jobData(j);

    // Update dot status class
    const dot = el.querySelector('.qp-dot');
    if (dot) dot.className = `qp-dot qp-${j.status}`;

    // Update name
    const nameEl = el.querySelector('.qp-name');
    if (nameEl) {
      const newName = esc(d.name);
      if (nameEl.innerHTML !== newName) nameEl.innerHTML = newName;
    }

    // Update status text + class
    const statusEl = el.querySelector('.qp-status');
    if (statusEl) {
      statusEl.className = `qp-status qp-${j.status}`;
      const newText = esc(d.statusText);
      if (statusEl.innerHTML !== newText) statusEl.innerHTML = newText;
    }

    // Update progress bar
    const showBar = d.isActive || d.isDone || d.isFailed;
    let track = el.querySelector('.qp-track');
    if (showBar) {
      if (!track) {
        track = document.createElement('div');
        track.className = 'qp-track';
        track.innerHTML = '<div class="qp-bar" style="width:0%"></div>';
        const row = el.querySelector('.qp-row');
        row.after(track);
      }
      const bar = track.querySelector('.qp-bar');
      bar.className = `qp-bar${d.barMod}`;
      bar.style.width = `${d.barPct}%`;
    } else if (track) {
      track.remove();
    }

    // Update meta
    let metaEl = el.querySelector('.qp-meta');
    if (d.meta.length) {
      const html = d.meta.join(' &middot; ');
      if (metaEl) {
        if (metaEl.innerHTML !== html) metaEl.innerHTML = html;
      } else {
        metaEl = document.createElement('div');
        metaEl.className = 'qp-meta';
        metaEl.innerHTML = html;
        (track || el.querySelector('.qp-row')).after(metaEl);
      }
    } else if (metaEl) {
      metaEl.remove();
    }

    // Update error
    let errEl = el.querySelector('.qp-err');
    if (d.isFailed && j.error) {
      const html = esc(j.error);
      if (errEl) {
        if (errEl.innerHTML !== html) errEl.innerHTML = html;
      } else {
        errEl = document.createElement('div');
        errEl.className = 'qp-err';
        errEl.innerHTML = html;
        (el.querySelector('.qp-meta') || track || el.querySelector('.qp-row')).after(errEl);
      }
    } else if (errEl) {
      errEl.remove();
    }

    // Update play controls
    let playEl = el.querySelector('.qp-play-wrap');
    const newPlayHTML = buildPlayHTML(j);
    if (newPlayHTML) {
      if (playEl) {
        playEl.outerHTML = newPlayHTML;
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = newPlayHTML;
        const actionsEl2 = el.querySelector('.qp-actions');
        if (actionsEl2) actionsEl2.before(tmp.firstElementChild);
        else el.appendChild(tmp.firstElementChild);
      }
      bindActions(el, j);
    } else if (playEl) {
      playEl.remove();
    }

    // Update actions — rebuild if status category changed
    const actionsEl = el.querySelector('.qp-actions');
    const newActionsHTML = buildActionsHTML(j, d);
    if (newActionsHTML) {
      if (actionsEl) {
        if (actionsEl.innerHTML !== newActionsHTML) {
          actionsEl.innerHTML = newActionsHTML;
          bindActions(el, j);
        }
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'qp-actions';
        wrap.innerHTML = newActionsHTML;
        el.appendChild(wrap);
        bindActions(el, j);
      }
    } else if (actionsEl) {
      actionsEl.remove();
    }
  }

  function buildActionsHTML(j, d) {
    if (d.isActive) {
      return `<button class="qp-btn qp-btn-cancel" data-cancel="${j.id}">Cancel</button>`;
    } else if (d.isDone) {
      const dlUrl = j.total_videos
        ? `${API}/download/playlist/${j.id}`
        : `${API}/download/${j.id}`;
      return `<a class="qp-btn qp-btn-dl" href="${dlUrl}">Download</a>`
           + `<button class="qp-btn qp-btn-rm" data-remove="${j.id}">Remove</button>`;
    } else if (d.isFailed) {
      return `<button class="qp-btn qp-btn-rm" data-remove="${j.id}">Remove</button>`;
    } else if (d.isInterrupted) {
      return `<button class="qp-btn qp-btn-resume" data-resume="${j.id}">Resume</button>`
           + `<button class="qp-btn qp-btn-rm" data-remove="${j.id}">Remove</button>`;
    }
    return '';
  }

  function buildPlayHTML(j) {
    if (j.status !== 'completed') return '';
    const isPlaylist = j.total_videos > 0 && j.video_titles && j.video_titles.length > 0;

    if (isPlaylist) {
      const playing = isPlaying(j.id, playingTrack) && playingJobId === j.id;
      const paused = isPaused(j.id, playingTrack) && playingJobId === j.id;
      const active = playing || paused;
      const trackName = active && j.video_titles[playingTrack]
        ? esc(j.video_titles[playingTrack]) : '';
      const trackInfo = active ? `<span class="qp-now-playing">${playingTrack + 1}/${j.video_titles.length} ${trackName}</span>` : '';

      return `<div class="qp-play-wrap" data-play-job="${j.id}">
        <button class="qp-play-btn" data-pl-prev="${j.id}" title="Previous">${ICO_PREV}</button>
        <button class="qp-play-btn${playing ? ' playing' : ''}" data-pl-play="${j.id}" title="${playing ? 'Pause' : 'Play'}">${playing ? ICO_PAUSE : ICO_PLAY}</button>
        <button class="qp-play-btn" data-pl-stop="${j.id}" title="Stop">${ICO_STOP}</button>
        <button class="qp-play-btn" data-pl-next="${j.id}" title="Next">${ICO_NEXT}</button>
        ${trackInfo}
      </div>`;
    } else {
      const playing = isPlaying(j.id);
      const paused = isPaused(j.id);
      return `<div class="qp-play-wrap" data-play-job="${j.id}">
        <button class="qp-play-btn${playing ? ' playing' : ''}" data-single-play="${j.id}" title="${playing ? 'Pause' : 'Play'}">${playing ? ICO_PAUSE : ICO_PLAY}</button>
        <button class="qp-play-btn" data-single-stop="${j.id}" title="Stop">${ICO_STOP}</button>
        ${playing || paused ? '<span class="qp-now-playing">Playing</span>' : ''}
      </div>`;
    }
  }

  function buildItemHTML(j, d) {
    const barHTML = (d.isActive || d.isDone || d.isFailed)
      ? `<div class="qp-track"><div class="qp-bar${d.barMod}" style="width:${d.barPct}%"></div></div>` : '';
    const metaHTML = d.meta.length ? `<div class="qp-meta">${d.meta.join(' &middot; ')}</div>` : '';
    const errHTML = d.isFailed && j.error ? `<div class="qp-err">${esc(j.error)}</div>` : '';
    const actionsHTML = buildActionsHTML(j, d);
    const playHTML = buildPlayHTML(j);

    return `<div class="qp-row">
          <span class="qp-dot qp-${j.status}"></span>
          <span class="qp-name">${esc(d.name)}</span>
          <span class="qp-status qp-${j.status}">${esc(d.statusText)}</span>
        </div>
        ${barHTML}${metaHTML}${errHTML}${playHTML}
        ${actionsHTML ? `<div class="qp-actions">${actionsHTML}</div>` : ''}`;
  }

  function bindActions(el, j) {
    el.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); cancelJob(btn.dataset.cancel); });
    });
    el.querySelectorAll('[data-resume]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); resumeJob(btn.dataset.resume); });
    });
    el.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeJob(btn.dataset.remove); });
    });
    // Single-track play
    el.querySelectorAll('[data-single-play]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); playSingle(btn.dataset.singlePlay); });
    });
    el.querySelectorAll('[data-single-stop]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); stopPlayback(); });
    });
    // Playlist play
    el.querySelectorAll('[data-pl-play]').forEach(btn => {
      const id = btn.dataset.plPlay;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (playingJobId === id && playingTrack >= 0) {
          playPlaylistTrack(id, playingTrack);
        } else {
          playPlaylistTrack(id, 0);
        }
      });
    });
    el.querySelectorAll('[data-pl-stop]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); stopPlayback(); });
    });
    el.querySelectorAll('[data-pl-prev]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); prevTrack(); });
    });
    el.querySelectorAll('[data-pl-next]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); nextTrack(); });
    });
  }

  // ── Playback ─────────────────────────────────────────────────────

  let stopping = false; // guard against recursive stop from error handler

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'auto';
      audio.addEventListener('ended', onTrackEnded);
      audio.addEventListener('error', () => {
        // Only auto-stop on real errors, not from clearing src
        if (!stopping && audio.src && audio.src !== window.location.href) {
          resetPlayback();
        }
      });
    }
    return audio;
  }

  function ensureVideo() {
    if (!video) {
      video = document.getElementById('queueVideo');
      if (!video) return null;
      video.addEventListener('ended', onTrackEnded);
      video.addEventListener('error', () => {
        if (!stopping && video.src) {
          resetPlayback();
        }
      });
    }
    return video;
  }

  function showVideoPanel(title) {
    if (!videoPanel) return;
    if (videoTitleEl) videoTitleEl.textContent = title || 'Video Player';
    videoPanel.classList.add('open');
  }

  function hideVideoPanel() {
    if (videoPanel) videoPanel.classList.remove('open');
  }

  function findJob(jobId) {
    return jobs.find(x => x.id === jobId) || null;
  }

  function isVideoJob(job) {
    return !!job && job.format_type === 'video';
  }

  function playSingle(jobId) {
    const j = findJob(jobId);
    if (isVideoJob(j)) {
      playVideoSingle(jobId);
      return;
    }

    const a = ensureAudio();
    if (playingJobId === jobId && playingTrack === -1) {
      // Toggle pause/resume
      if (a.paused) { a.play().catch(() => {}); } else { a.pause(); }
      renderQueue();
      return;
    }
    silentStop();
    mediaMode = 'audio';
    playingJobId = jobId;
    playingTrack = -1;
    a.src = `${API}/stream/${jobId}`;
    a.play().catch(() => {});
    renderQueue();
  }

  function playVideoSingle(jobId) {
    const v = ensureVideo();
    if (!v) return;
    const j = findJob(jobId);

    if (playingJobId === jobId && playingTrack === -1 && mediaMode === 'video') {
      if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
      renderQueue();
      return;
    }

    silentStop();
    mediaMode = 'video';
    playingJobId = jobId;
    playingTrack = -1;
    v.src = `${API}/stream/${jobId}`;
    v.load();
    showVideoPanel(j && (j.playlist_title || j.file_name || j.current_title || 'Video'));
    v.play().catch(() => {});
    renderQueue();
  }

  function playPlaylistTrack(jobId, index) {
    const j = jobs.find(x => x.id === jobId);
    if (!j || !j.video_titles || index < 0 || index >= j.video_titles.length) return;

    if (isVideoJob(j)) {
      playVideoPlaylistTrack(jobId, index, j);
      return;
    }

    const a = ensureAudio();

    if (playingJobId === jobId && playingTrack === index) {
      if (a.paused) { a.play().catch(() => {}); } else { a.pause(); }
      renderQueue();
      return;
    }
    silentStop();
    mediaMode = 'audio';
    playingJobId = jobId;
    playingTrack = index;
    a.src = `${API}/stream/${jobId}/${index}`;
    a.load();
    a.play().catch(() => {});
    renderQueue();
  }

  function playVideoPlaylistTrack(jobId, index, job) {
    const v = ensureVideo();
    if (!v) return;

    if (playingJobId === jobId && playingTrack === index && mediaMode === 'video') {
      if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
      renderQueue();
      return;
    }

    silentStop();
    mediaMode = 'video';
    playingJobId = jobId;
    playingTrack = index;
    v.src = `${API}/stream/${jobId}/${index}`;
    v.load();
    const title = job.video_titles && job.video_titles[index] ? job.video_titles[index] : (job.playlist_title || 'Video');
    showVideoPanel(title);
    v.play().catch(() => {});
    renderQueue();
  }

  function prevTrack() {
    if (!playingJobId || playingTrack <= 0) return;
    playPlaylistTrack(playingJobId, playingTrack - 1);
  }

  function nextTrack() {
    if (!playingJobId || playingTrack < 0) return;
    const j = jobs.find(x => x.id === playingJobId);
    if (!j || !j.video_titles) return;
    if (playingTrack + 1 < j.video_titles.length) {
      playPlaylistTrack(playingJobId, playingTrack + 1);
    } else {
      resetPlayback();
    }
  }

  /** Stop audio without clearing src (avoids error event loop) */
  function silentStop() {
    stopping = true;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
    }
    if (video) {
      video.pause();
      video.currentTime = 0;
      video.removeAttribute('src');
      video.load();
    }
    hideVideoPanel();
    stopping = false;
  }

  /** Full stop — reset state and update UI */
  function stopPlayback() {
    silentStop();
    mediaMode = null;
    playingJobId = null;
    playingTrack = -1;
    renderQueue();
  }

  /** Reset without re-render (used internally) */
  function resetPlayback() {
    silentStop();
    mediaMode = null;
    playingJobId = null;
    playingTrack = -1;
    if (popupOpen) renderQueue();
  }

  function onTrackEnded() {
    if (playingTrack >= 0) {
      nextTrack();
    } else {
      resetPlayback();
    }
  }

  function isPlaying(jobId, trackIndex) {
    const m = mediaMode === 'video' ? video : audio;
    return m && !m.paused && playingJobId === jobId &&
           (trackIndex === undefined ? playingTrack === -1 : playingTrack === trackIndex);
  }

  function isPaused(jobId, trackIndex) {
    const m = mediaMode === 'video' ? video : audio;
    return m && m.paused && m.src && playingJobId === jobId &&
           (trackIndex === undefined ? playingTrack === -1 : playingTrack === trackIndex);
  }

  // SVG icons
  const ICO_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const ICO_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>';
  const ICO_STOP = '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>';
  const ICO_PREV = '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>';
  const ICO_NEXT = '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6zm10-12v12h2V6z"/></svg>';

  // ── Actions ──────────────────────────────────────────────────────

  async function getCsrfToken() {
    try {
      const r = await fetch(`${API}/auth/session`, { credentials: 'include' });
      if (!r.ok) return null;
      const data = await r.json();
      return data && data.csrf_token ? data.csrf_token : null;
    } catch {
      return null;
    }
  }

  async function cancelJob(id) {
    if (playingJobId === id) stopPlayback();
    try {
      const csrf = await getCsrfToken();
      await fetch(`${API}/queue/${id}/cancel`, {
        method: 'POST',
        credentials: 'include',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      });
    } catch (e) { console.error(e); }
    fetchQueue();
  }

  async function removeJob(id) {
    if (playingJobId === id) stopPlayback();
    try {
      const csrf = await getCsrfToken();
      await fetch(`${API}/queue/${id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      });
    } catch (e) { console.error(e); }
    fetchQueue();
  }

  async function resumeJob(id) {
    try {
      const csrf = await getCsrfToken();
      await fetch(`${API}/queue/${id}/resume`, {
        method: 'POST',
        credentials: 'include',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      });
    } catch (e) { console.error(e); }
    fetchQueue();
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
  }

  // ── Boot ─────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQueue);
  } else {
    initQueue();
  }
})();
