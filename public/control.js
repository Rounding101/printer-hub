// Per-printer control view (#control/<id>): camera, status, jog, temperatures,
// fans, speed and filament slots. Uses api(), toast(), dur(), deg(), cards,
// mountCamera(), confirmCancel() and STATUS_LABEL from app.js.
const Control = (() => {
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('.view[data-view="control"]');
  const enc = encodeURIComponent;
  // A card-shaped object so app.js's mountCamera() can drive this view's camera.
  const view = { el: root, state: null, camKind: undefined, player: null };
  let printerId = null;
  let step = 10;
  let uploadMode = 'upload';
  const editing = new Set(); // inputs the user is touching; don't overwrite them from live updates

  const BUSY = ['printing', 'pausing', 'paused', 'heating', 'cancelling', 'busy'];

  async function send(cmd, label) {
    try {
      await api(`/api/printers/${enc(printerId)}/control`, { body: cmd });
      if (label) toast(label);
    } catch (err) { toast(err.message, true); }
  }

  // ---- Open / close -------------------------------------------------------------

  function open(id) {
    if (!cards.has(id)) { location.hash = '#printers'; return; }
    if (printerId !== id) {
      close();
      printerId = id;
      view.camKind = undefined;
    }
    syncPrinterSelect();
    render(cards.get(id).state, true);
  }

  function close() {
    view.player?.destroy();
    view.player = null;
    root.querySelector('.ctl-cam').querySelectorAll('img, video').forEach(stopMedia);
    root.querySelector('.ctl-cam').classList.remove('has-feed');
    view.camKind = undefined;
  }

  function syncPrinterSelect() {
    const sel = $('ctl-printer');
    sel.replaceChildren(...[...cards.values()].map((c) => new Option(c.state.name, c.state.id)));
    sel.value = printerId;
  }

  // ---- Rendering ----------------------------------------------------------------

  function render(state, force = false) {
    if (state.id !== printerId) return;
    view.state = state;
    const s = state.status;
    const job = state.job;
    const caps = state.capabilities || {};
    const ctl = caps.control || {};
    const busy = BUSY.includes(s);

    $('ctl-name').textContent = state.name;
    $('ctl-pill').textContent = STATUS_LABEL[s] || s;
    $('ctl-pill').dataset.s = s;
    root.dataset.s = s;
    $('ctl-file-name').textContent = job?.file || (state.online ? 'No active job' : 'Printer offline');
    $('ctl-file-name').title = job?.file || '';
    $('ctl-fill').style.width = `${Math.min(100, job?.progress || 0)}%`;
    $('ctl-pct').textContent = job ? `${(job.progress || 0).toFixed(job.progress % 1 ? 1 : 0)}%` : '—';
    $('ctl-layer').textContent = job?.totalLayers ? `${job.layer} / ${job.totalLayers}` : '—';
    const remaining = job && BUSY.includes(s) ? job.remaining : null;
    $('ctl-remaining').textContent = remaining ? dur(remaining) : '—';
    $('ctl-eta').textContent = remaining
      ? new Date(Date.now() + remaining * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      : '—';
    $('ctl-err').hidden = !state.error;
    $('ctl-err').textContent = state.error || '';

    const act = (name) => root.querySelector(`[data-act="${name}"]`);
    act('pause').hidden = !(state.online && (s === 'printing' || s === 'heating'));
    act('resume').hidden = !(state.online && s === 'paused');
    act('cancel').hidden = !(state.online && ['printing', 'heating', 'pausing', 'paused'].includes(s));
    act('light').hidden = !(state.online && caps.light && state.light != null);
    act('light').textContent = state.light ? 'Light on' : 'Light off';
    act('light').setAttribute('aria-pressed', String(!!state.light));
    act('motorsOff').hidden = !ctl.motorsOff;
    act('motorsOff').disabled = busy || !state.online;

    // Motion
    const canMove = state.online && ctl.jog && !busy;
    root.querySelectorAll('.ctl-motion .wedge, .ctl-motion .hub, .ctl-motion button').forEach((el) => {
      if (el.closest('#ctl-step')) return;
      el.classList.toggle('disabled', !canMove);
      if (el.tagName === 'BUTTON') el.disabled = !canMove;
      el.setAttribute('aria-disabled', String(!canMove));
    });
    $('ctl-motion-note').textContent = !state.online ? 'Printer offline.'
      : busy ? 'Movement is locked while a print is running.'
        : 'Home the axes before moving. Moves are relative, in mm.';

    renderTemps(state, ctl, force);
    renderFans(state, ctl, force);
    renderSpeed(state, force);
    renderSlots(state);
    mountCamera(view);
  }

  function heaterRow(key, label, t, max) {
    let row = $(`ctl-temp-${key}`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'ctl-row';
      row.id = `ctl-temp-${key}`;
      row.innerHTML = `
        <span class="ctl-row-label"></span>
        <span class="ctl-row-cur"></span>
        <input type="range" min="0" step="1" aria-label="">
        <input type="number" min="0" step="1" class="ctl-num" aria-label="">
        <button type="button" class="btn small">Set</button>`;
      const [range, num, btn] = row.querySelectorAll('input, button');
      const sync = (from, to) => { to.value = from.value; };
      for (const el of [range, num]) {
        el.addEventListener('focus', () => editing.add(row.id));
        el.addEventListener('blur', () => setTimeout(() => editing.delete(row.id), 300));
      }
      range.addEventListener('input', () => sync(range, num));
      num.addEventListener('input', () => sync(num, range));
      range.addEventListener('change', () => apply());
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
      btn.addEventListener('click', () => apply());
      const apply = () => {
        editing.delete(row.id);
        send({ action: 'temp', heater: key, target: Number(num.value) }, `${label} → ${num.value}°C`);
      };
      $('ctl-temps').append(row);
    }
    const [range, num] = row.querySelectorAll('input');
    row.querySelector('.ctl-row-label').textContent = label;
    row.querySelector('.ctl-row-cur').innerHTML = `${deg(t?.cur)} <small>/ ${t?.target ? deg(t.target) : 'off'}</small>`;
    range.max = num.max = max;
    range.setAttribute('aria-label', `${label} target`);
    num.setAttribute('aria-label', `${label} target °C`);
    if (!editing.has(row.id)) range.value = num.value = Math.round(t?.target || 0);
    row.style.setProperty('--fill', `${Math.min(100, ((t?.cur || 0) / max) * 100)}%`);
  }

  function renderTemps(state, ctl) {
    const limits = ctl.limits || { nozzle: 300, bed: 110 };
    const heaters = ctl.temps || [];
    if (!heaters.length) { $('ctl-temps').innerHTML = '<p class="dlg-hint">Temperature control isn’t available for this printer.</p>'; return; }
    if (heaters.includes('nozzle')) heaterRow('nozzle', 'Nozzle', state.temps?.nozzle, limits.nozzle);
    if (heaters.includes('bed')) heaterRow('bed', 'Bed', state.temps?.bed, limits.bed);
    if (state.temps?.chamber) {
      let row = $('ctl-temp-chamber');
      if (!row) {
        row = Object.assign(document.createElement('div'), { className: 'ctl-row readonly', id: 'ctl-temp-chamber' });
        row.innerHTML = '<span class="ctl-row-label">Chamber</span><span class="ctl-row-cur"></span>';
        $('ctl-temps').append(row);
      }
      row.querySelector('.ctl-row-cur').textContent = deg(state.temps.chamber.cur);
    }
    $('ctl-presets').hidden = !state.online;
  }

  function renderFans(state, ctl) {
    const box = $('ctl-fans');
    const settable = new Set(ctl.fans || []);
    const fans = { part: state.fans?.part ?? null, ...state.fans };
    const labels = { part: 'Part fan', aux: 'Aux fan', chamber: 'Chamber fan' };
    for (const [key, pct] of Object.entries(fans)) {
      if (pct == null && !settable.has(key)) continue;
      const id = `ctl-fan-${key}`;
      let row = $(id);
      if (!row) {
        row = Object.assign(document.createElement('div'), { className: 'ctl-row fan', id });
        row.innerHTML = `<span class="ctl-row-label"></span><span class="ctl-row-cur"></span>${settable.has(key) ? '<input type="range" min="0" max="100" step="5">' : ''}`;
        const range = row.querySelector('input');
        if (range) {
          range.addEventListener('pointerdown', () => editing.add(id));
          range.addEventListener('input', () => { row.querySelector('.ctl-row-cur').textContent = `${range.value}%`; });
          range.addEventListener('change', () => {
            editing.delete(id);
            send({ action: 'fan', fan: key, pct: Number(range.value) }, `${labels[key]} → ${range.value}%`);
          });
          range.setAttribute('aria-label', `${labels[key] || key} speed`);
        }
        box.append(row);
      }
      row.querySelector('.ctl-row-label').textContent = labels[key] || key;
      const range = row.querySelector('input');
      if (!editing.has(id)) {
        row.querySelector('.ctl-row-cur').textContent = pct == null ? '—' : `${Math.round(pct)}%`;
        if (range) range.value = Math.round(pct || 0);
      }
      if (range) range.disabled = !state.online;
    }
  }

  function renderSpeed(state) {
    const box = $('ctl-speed');
    const sp = state.speed;
    if (!sp) { box.replaceChildren(); box.dataset.kind = ''; return; }
    if (box.dataset.kind !== sp.kind) {
      box.dataset.kind = sp.kind;
      box.replaceChildren();
      const label = Object.assign(document.createElement('span'), { className: 'ctl-row-label', textContent: 'Print speed' });
      const row = Object.assign(document.createElement('div'), { className: 'ctl-row speed' });
      row.append(label);
      if (sp.kind === 'mode') {
        const seg = Object.assign(document.createElement('div'), { className: 'seg', role: 'radiogroup' });
        seg.setAttribute('aria-label', 'Print speed mode');
        for (const o of sp.options) {
          const b = Object.assign(document.createElement('button'), { type: 'button', textContent: o.label });
          b.dataset.value = o.value;
          b.setAttribute('role', 'radio');
          b.onclick = () => send({ action: 'speed', value: o.value }, `Speed → ${o.label}`);
          seg.append(b);
        }
        row.append(seg);
      } else {
        const cur = Object.assign(document.createElement('span'), { className: 'ctl-row-cur' });
        const range = Object.assign(document.createElement('input'), { type: 'range', min: sp.min, max: sp.max, step: 5 });
        range.setAttribute('aria-label', 'Print speed percent');
        range.addEventListener('pointerdown', () => editing.add('speed'));
        range.addEventListener('input', () => { cur.textContent = `${range.value}%`; });
        range.addEventListener('change', () => { editing.delete('speed'); send({ action: 'speed', value: Number(range.value) }, `Speed → ${range.value}%`); });
        row.append(cur, range);
      }
      box.append(row);
    }
    if (sp.kind === 'mode') {
      box.querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.value) === Number(sp.value))));
    } else if (!editing.has('speed')) {
      box.querySelector('input').value = sp.value;
      box.querySelector('.ctl-row-cur').textContent = `${sp.value}%`;
    }
  }

  function renderSlots(state) {
    const box = $('ctl-slots');
    $('ctl-slots-refresh').hidden = !state.slots;
    if (!state.slots?.length) {
      box.dataset.sig = '';
      box.innerHTML = `<p class="dlg-hint">${state.type === 'flashforge' ? 'Single extruder: load filament from the printer’s screen.' : 'No multi-color unit reported.'}</p>`;
      return;
    }
    const sig = JSON.stringify(state.slots);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren(...state.slots.map((s) => {
      const el = document.createElement('div');
      el.className = 'spool' + (s.ready ? '' : ' empty');
      el.innerHTML = `<div class="spool-reel"><span class="spool-color"></span></div><span class="spool-type"></span><span class="spool-meta"></span>`;
      el.querySelector('.spool-color').style.background = `rgb(${s.color.join(',')})`;
      el.querySelector('.spool-type').textContent = s.ready ? (s.type || 'Unknown') : 'Empty';
      el.querySelector('.spool-meta').textContent = `Slot ${s.index + 1}${s.ready && s.percent != null ? ` · ${s.percent}%` : ''}`;
      el.title = `Slot ${s.index + 1}: ${s.ready ? s.type : 'not loaded'}`;
      return el;
    }));
  }

  // ---- Wiring -------------------------------------------------------------------

  function init() {
    $('ctl-printer').addEventListener('change', (e) => { location.hash = `#control/${enc(e.target.value)}`; });

    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
      uploadMode = b.dataset.mode;
      root.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    }));
    const drop = $('ctl-drop');
    const handle = (file) => file && Files.uploadToPrinter(file, printerId, { print: uploadMode === 'print', progressEl: $('ctl-progress') });
    $('ctl-file').addEventListener('change', (e) => { handle(e.target.files[0]); e.target.value = ''; });
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
    $('ctl-browse').addEventListener('click', () => Files.openPrinterFiles(printerId));

    root.querySelector('.ctl-cam .cam-full').addEventListener('click', () => root.querySelector('.ctl-cam').requestFullscreen?.());

    const act = (name, fn) => root.querySelector(`[data-act="${name}"]`).addEventListener('click', fn);
    const simple = (path) => async () => {
      try { await api(`/api/printers/${enc(printerId)}/${path}`, { body: {} }); } catch (err) { toast(err.message, true); }
    };
    act('pause', simple('pause'));
    act('resume', simple('resume'));
    act('cancel', () => confirmCancel({ state: view.state }, simple('cancel')));
    act('light', async () => {
      try { await api(`/api/printers/${enc(printerId)}/light`, { body: { on: !view.state.light } }); } catch (err) { toast(err.message, true); }
    });
    act('motorsOff', () => send({ action: 'motorsOff' }, 'Motors off'));

    // Step size
    $('ctl-step').querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      step = Number(b.dataset.step);
      $('ctl-step').querySelectorAll('[data-step]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    }));

    // Jog pad (SVG wedges are keyboard-focusable role=button groups)
    const activate = (el, fn) => {
      el.addEventListener('click', () => { if (el.getAttribute('aria-disabled') !== 'true') fn(); });
      el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute('aria-disabled') !== 'true') { e.preventDefault(); fn(); } });
    };
    root.querySelectorAll('.jog .wedge').forEach((w) => activate(w, () => {
      const d = step * Number(w.dataset.dir);
      send({ action: 'jog', axis: w.dataset.axis, distance: d });
    }));
    root.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => {
      send({ action: 'jog', axis: 'z', distance: Math.min(step, 10) * Number(b.dataset.z) });
    }));
    root.querySelectorAll('[data-home]').forEach((el) => activate(el, () => send({ action: 'home', axes: el.dataset.home }, `Homing ${el.dataset.home.toUpperCase()}`)));

    // Temperature presets: nozzle,bed
    $('ctl-presets').querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', async () => {
      const [nozzle, bed] = b.dataset.preset.split(',').map(Number);
      const limits = view.state?.capabilities?.control?.limits || {};
      await send({ action: 'temp', heater: 'nozzle', target: Math.min(nozzle, limits.nozzle ?? nozzle) });
      await send({ action: 'temp', heater: 'bed', target: Math.min(bed, limits.bed ?? bed) });
      toast(nozzle ? `Preheating for ${b.textContent}` : 'Cooling down');
    }));

    $('ctl-slots-refresh').addEventListener('click', async () => {
      try { await api(`/api/printers/${enc(printerId)}/slots`, { body: {} }); } catch (err) { toast(err.message, true); }
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    open,
    close,
    onState: (state) => { if (state.id === printerId && !root.hidden) render(state); },
    get printerId() { return printerId; },
  };
})();
