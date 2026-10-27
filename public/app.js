const grid = document.getElementById('grid');
const tpl = document.getElementById('card-tpl');
const cards = new Map(); // id -> { el, state, camKind, player }

const STATUS_LABEL = {
  offline: 'Offline', idle: 'Ready', heating: 'Heating', printing: 'Printing', pausing: 'Pausing',
  paused: 'Paused', cancelling: 'Cancelling', completed: 'Done', busy: 'Busy', error: 'Error',
};
const ACTIVE = ['printing', 'pausing', 'paused', 'heating'];

// ---- Formatting -----------------------------------------------------------------

function dur(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
const deg = (t) => (t == null ? '—' : `${Math.round(t)}°`);

function toast(msg, bad = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- Camera ---------------------------------------------------------------------

// Removing an <img> doesn't end its MJPEG download; blank the source first, or
// leaked streams pile up until the browser's per-host connection limit stalls
// every other request to the hub.
function stopMedia(el) {
  if (el.tagName === 'IMG') { el.onload = el.onerror = null; el.src = 'data:,'; }
  else if (el.tagName === 'VIDEO') { el.removeAttribute('src'); el.load(); }
  el.remove();
}

function mountCamera(card) {
  const { el, state } = card;
  const cam = el.querySelector('.cam');
  if (card.camKind === state.camera) return;
  card.player?.destroy();
  card.player = null;
  cam.querySelectorAll('img, video').forEach(stopMedia);
  cam.classList.remove('has-feed');
  card.camKind = state.camera;
  if (!state.camera) return;

  const src = `/api/printers/${encodeURIComponent(state.id)}/camera`;
  if (state.camera === 'mjpeg') {
    const img = new Image();
    img.alt = `${state.name} camera`;
    img.onload = () => cam.classList.add('has-feed');
    img.onerror = () => fallbackSnapshots(card);
    img.src = src;
    cam.prepend(img);
  } else if (state.camera === 'flv' && window.mpegts?.isSupported()) {
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    cam.prepend(video);
    const player = mpegts.createPlayer({ type: 'flv', isLive: true, url: src }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
    player.attachMediaElement(video);
    player.on(mpegts.Events.ERROR, () => fallbackSnapshots(card));
    video.addEventListener('playing', () => cam.classList.add('has-feed'), { once: true });
    player.load();
    video.play().catch(() => {});
    card.player = { destroy: () => { player.destroy(); } };
  }
}

// When a live stream fails, poll still snapshots instead (and retry the stream later).
function fallbackSnapshots(card) {
  const cam = card.el.querySelector('.cam');
  card.player?.destroy();
  cam.querySelectorAll('img, video').forEach(stopMedia);
  cam.classList.remove('has-feed');
  const img = new Image();
  img.alt = `${card.state.name} camera snapshot`;
  img.onload = () => cam.classList.add('has-feed');
  cam.prepend(img);
  const base = `/api/printers/${encodeURIComponent(card.state.id)}/snapshot`;
  let failures = 0;
  const refresh = () => { img.src = `${base}?t=${Date.now()}`; };
  img.onerror = () => { cam.classList.remove('has-feed'); failures++; };
  refresh();
  const timer = setInterval(() => {
    if (failures > 5) { clearInterval(timer); retry(); return; }
    refresh();
  }, 2000);
  const retry = () => setTimeout(() => { card.camKind = null; mountCamera(card); }, 30000);
  card.player = { destroy: () => clearInterval(timer) };
}

// ---- Cards ----------------------------------------------------------------------

function createCard(state) {
  const el = tpl.content.firstElementChild.cloneNode(true);
  const card = { el, state, camKind: undefined, player: null };
  const id = encodeURIComponent(state.id);

  const run = (btn, action, body) => async () => {
    btn.disabled = true;
    try { await api(`/api/printers/${id}/${action}`, { body: body ? body() : {} }); }
    catch (err) { toast(`${card.state.name}: ${err.message}`, true); }
    finally { btn.disabled = false; }
  };

  const q = (s) => el.querySelector(s);
  q('.act-pause').onclick = run(q('.act-pause'), 'pause');
  q('.act-resume').onclick = run(q('.act-resume'), 'resume');
  q('.act-light').onclick = run(q('.act-light'), 'light', () => ({ on: !card.state.light }));
  q('.act-cancel').onclick = () => confirmCancel(card, run(q('.act-cancel'), 'cancel'));
  q('.act-print').onclick = () => Files.openPrinterFiles(card.state.id);
  q('.cam-full').onclick = () => q('.cam').requestFullscreen?.();

  q('.act-controls').href = `#control/${id}`;

  cards.set(state.id, card);
  grid.append(el);
  Jobs.syncPrinters();
  Files.renderLibrary();
  if (pendingControl === state.id) { pendingControl = null; setTimeout(() => Control.open(state.id)); }
  return card;
}

function render(state) {
  const card = cards.get(state.id) || createCard(state);
  card.state = state;
  const { el } = card;
  const q = (s) => el.querySelector(s);
  const s = state.status;

  el.dataset.s = s;
  el.classList.toggle('offline', !state.online);
  q('.name').textContent = state.name;
  q('.model').textContent = [state.model, state.host].filter(Boolean).join(' · ') || state.type;
  q('.pill').textContent = STATUS_LABEL[s] || s;
  q('.pill').dataset.s = s;

  const job = state.job;
  q('.job').hidden = !job;
  q('.nojob').hidden = !!job;
  q('.nojob').textContent = state.online ? 'No active job' : 'Waiting for printer…';
  if (job) {
    q('.file').textContent = job.file || 'Untitled';
    q('.file').title = job.file || '';
    q('.fill').style.width = `${Math.min(100, job.progress || 0)}%`;
    q('.pct').textContent = `${(job.progress || 0).toFixed(job.progress % 1 ? 1 : 0)}%`;
    q('.layer').textContent = job.totalLayers ? `${job.layer} / ${job.totalLayers}` : '—';
    q('.elapsed').textContent = dur(job.elapsed);
    q('.remaining').textContent = ACTIVE.includes(s) ? dur(job.remaining) : '—';
  }

  const temps = q('.temps');
  const entries = Object.entries(state.temps || {});
  temps.hidden = !state.online || !entries.length;
  temps.replaceChildren(...entries.map(([k, t]) => {
    const d = document.createElement('div');
    d.className = 'temp';
    d.innerHTML = `<span class="k"></span><span class="v"></span>`;
    d.firstChild.textContent = k[0].toUpperCase() + k.slice(1);
    d.lastChild.innerHTML = `${deg(t.cur)}${t.target ? ` <small>/ ${deg(t.target)}</small>` : ''}`;
    return d;
  }));

  q('.err').hidden = !state.error;
  q('.err').textContent = state.error || '';

  const caps = state.capabilities || {};
  const on = state.online;
  q('.act-pause').hidden = !(on && caps.pause && (s === 'printing' || s === 'heating'));
  q('.act-resume').hidden = !(on && caps.resume && s === 'paused');
  q('.act-cancel').hidden = !(on && caps.cancel && ['printing', 'heating', 'pausing', 'paused'].includes(s));
  q('.act-print').hidden = !(on && caps.files && ['idle', 'completed'].includes(s));
  q('.act-light').hidden = !(on && caps.light && state.light != null);
  q('.act-light').setAttribute('aria-pressed', String(!!state.light));
  q('.act-light').textContent = state.light ? 'Light on' : 'Light off';

  // The dashboard and control view each hold a camera stream; only run the visible one.
  if (document.querySelector('.view[data-view="control"]').hidden) mountCamera(card);
  else { card.player?.destroy(); card.player = null; card.camKind = undefined; card.el.querySelectorAll('.cam img, .cam video').forEach(stopMedia); }
  Control.onState(state);
  updateSummary();
  const key = `${state.online}:${state.status}`;
  if (card.statusKey !== key) { card.statusKey = key; Files.renderLibrary(); }
}

function updateSummary() {
  const all = [...cards.values()].map((c) => c.state);
  const printing = all.filter((p) => ['printing', 'heating', 'pausing'].includes(p.status)).length;
  const paused = all.filter((p) => p.status === 'paused').length;
  const offline = all.filter((p) => !p.online).length;
  const parts = [`${printing} printing`];
  if (paused) parts.push(`${paused} paused`);
  if (offline) parts.push(`${offline} offline`);
  document.getElementById('summary').textContent = `${all.length} printers · ${parts.join(' · ')}`;
}

// ---- Dialogs --------------------------------------------------------------------

function confirmCancel(card, go) {
  const dlg = document.getElementById('confirm-dlg');
  dlg.querySelector('.confirm-title').textContent = `Cancel print on ${card.state.name}?`;
  dlg.querySelector('.confirm-text').textContent = `${card.state.job?.file || 'The current job'} will be stopped. This can't be undone.`;
  dlg.onclose = () => { if (dlg.returnValue === 'yes') go(); };
  dlg.showModal();
}

// ---- Views ----------------------------------------------------------------------

function showView() {
  const [view, arg] = (location.hash.slice(1) || 'printers').split('/');
  const known = ['printers', 'control', 'library', 'jobs', 'totals'].includes(view) ? view : 'printers';
  if (known === 'control') {
    // Printers arrive over SSE; open once the card exists.
    const id = decodeURIComponent(arg || '');
    if (cards.has(id)) Control.open(id); else pendingControl = id;
  } else {
    Control.close();
  }
  document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === (known === 'control' ? 'printers' : known) ? 'page' : 'false'));
  document.querySelectorAll('.view').forEach((el) => { el.hidden = !el.dataset.view.split(' ').includes(known); });
  document.querySelectorAll('[data-sub]').forEach((el) => { el.hidden = el.dataset.sub !== known; });
  if (known === 'jobs' || known === 'totals') Jobs.render();
}
let pendingControl = null;
window.addEventListener('hashchange', showView);
showView();

// ---- Live updates ---------------------------------------------------------------

function connect() {
  const conn = document.getElementById('conn');
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => { conn.classList.add('live'); JSON.parse(e.data).forEach(render); });
  es.addEventListener('printer', (e) => render(JSON.parse(e.data)));
  es.addEventListener('jobs', (e) => Jobs.setAll(JSON.parse(e.data)));
  es.addEventListener('job', (e) => Jobs.upsert(JSON.parse(e.data)));
  es.addEventListener('library', (e) => Files.setLibrary(JSON.parse(e.data)));
  es.addEventListener('spools', (e) => Control.setSpools(JSON.parse(e.data)));
  es.onerror = () => conn.classList.remove('live'); // EventSource reconnects on its own
}

connect();
