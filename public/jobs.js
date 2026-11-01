// Job log + totals views. Uses api(), toast(), dur() and cards from app.js.
const Jobs = (() => {
  let jobs = [];
  const $ = (id) => document.getElementById(id);
  const OUTCOME_LABEL = { printing: 'Printing', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed', unknown: 'Unknown' };
  const fmtDate = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const hours = (s) => `${(s / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })}h`;
  const key = (j) => j.item.toLowerCase();

  // ---- Filters --------------------------------------------------------------

  function periodStart(v) {
    const now = new Date();
    if (v === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (v === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    if (v === 'year') return new Date(now.getFullYear(), 0, 1).getTime();
    if (/^\d+$/.test(v)) return Date.now() - Number(v) * 86400000;
    return 0;
  }

  function filtered() {
    const since = periodStart($('f-period').value);
    const printer = $('f-printer').value;
    const q = $('f-search').value.trim().toLowerCase();
    return jobs.filter((j) =>
      j.startedAt >= since &&
      (!printer || j.printerId === printer) &&
      (!q || j.item.toLowerCase().includes(q) || j.file.toLowerCase().includes(q)));
  }

  // ---- Rendering ------------------------------------------------------------

  function reprintButton(printerId, file) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = 'Reprint';
    const p = cards.get(printerId)?.state;
    const ready = p && p.online && ['idle', 'completed'].includes(p.status);
    b.disabled = !ready;
    b.title = !p ? 'Printer not in the hub' : ready ? `Print ${file} on ${p.name}` : `${p.name} is ${p.online ? p.status : 'offline'}`;
    b.onclick = () => Files.openPrint(printerId, file);
    return b;
  }

  function cell(tr, content, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (content instanceof Node) td.append(content); else td.textContent = content ?? '';
    tr.append(td);
    return td;
  }

  function renderJobs(list) {
    const body = $('jobs-body');
    body.replaceChildren(...list.map((j) => {
      const tr = document.createElement('tr');
      cell(tr, fmtDate(j.startedAt), 'nowrap');
      cell(tr, j.printerName, 'nowrap');
      const name = cell(tr, j.item, 'item');
      name.title = j.file;
      if (j.manual) name.insertAdjacentHTML('beforeend', ' <span class="tag">manual</span>');
      // Why a print that didn't finish ended, as the printer reported it.
      if (j.endReason) name.append(Object.assign(document.createElement('span'), { className: 'lib-sub job-reason', textContent: j.endReason }));

      if (j.outcome === 'printing') {
        const live = cards.get(j.printerId)?.state.job?.progress ?? j.progress ?? 0;
        cell(tr, Object.assign(document.createElement('span'), { className: 'outcome', textContent: `Printing ${Math.round(live)}%` })).firstChild.dataset.o = 'printing';
      } else {
        const sel = document.createElement('select');
        sel.className = 'outcome';
        sel.dataset.o = j.outcome;
        sel.setAttribute('aria-label', 'Outcome');
        for (const o of ['completed', 'cancelled', 'failed', 'unknown']) sel.add(new Option(OUTCOME_LABEL[o], o, false, o === j.outcome));
        sel.onchange = () => patch(j.id, { outcome: sel.value });
        cell(tr, sel);
      }

      const qty = document.createElement('input');
      qty.type = 'number'; qty.min = '0'; qty.value = j.quantity; qty.className = 'qty';
      qty.setAttribute('aria-label', 'Items per plate');
      if (!j.quantitySet) { qty.classList.add('unset'); qty.title = 'Not set yet — enter how many items this plate makes; it becomes the default for this model'; }
      qty.onchange = () => patch(j.id, { quantity: qty.value });
      cell(tr, qty, 'num');

      cell(tr, j.printSeconds ? dur(j.printSeconds) : '—', 'num nowrap');
      const fil = cell(tr, j.grams != null ? `${Math.round(j.grams)} g` : j.filamentPlan ? `~${Math.round(j.filamentPlan.reduce((n, p) => n + p.grams, 0))} g` : '—', 'num nowrap');
      const slotsUsed = (j.filament || j.filamentPlan || []).map((p) => (p.slot == null ? `unassigned ${Math.round(p.grams)} g` : `slot ${p.slot + 1}: ${Math.round(p.grams)} g`));
      fil.title = slotsUsed.length ? `${j.filament ? 'Used' : 'Planned'}: ${slotsUsed.join(', ')}` : 'No filament estimate for this job';

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      if (!j.manual && j.outcome !== 'printing') actions.append(reprintButton(j.printerId, j.file));
      if (j.outcome !== 'printing') {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'btn small ghost'; del.textContent = 'Delete';
        del.onclick = async () => {
          if (!confirm(`Delete this ${j.item} job from the log?`)) return;
          try { await api(`/api/jobs/${j.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
        };
        actions.append(del);
      }
      cell(tr, actions, 'actions');
      return tr;
    }));
    $('jobs-empty').hidden = list.length > 0;
  }

  function renderTotals(list) {
    const groups = new Map();
    for (const j of list) {
      const g = groups.get(key(j)) || { item: j.item, items: 0, plates: 0, secs: 0, grams: 0, bad: 0, last: null, qtys: new Set() };
      if (j.outcome === 'completed') {
        g.items += j.quantity; g.plates += 1; g.secs += j.printSeconds || 0; g.grams += j.grams || 0; g.qtys.add(j.quantity);
        if (!g.last || j.startedAt > g.last.startedAt) g.last = j;
      } else if (j.outcome === 'failed' || j.outcome === 'cancelled') {
        g.bad += 1; g.secs += j.printSeconds || 0; g.grams += j.grams || 0;
      }
      groups.set(key(j), g);
    }
    const rows = [...groups.values()].filter((g) => g.plates || g.bad).sort((a, b) => b.items - a.items || b.plates - a.plates);
    $('totals-body').replaceChildren(...rows.map((g) => {
      const tr = document.createElement('tr');
      cell(tr, g.item, 'item');
      cell(tr, g.items.toLocaleString(), 'num strong');
      cell(tr, g.plates.toLocaleString(), 'num');
      cell(tr, [...g.qtys].sort((a, b) => a - b).join(', ') || '—', 'num');
      cell(tr, hours(g.secs), 'num');
      cell(tr, g.grams ? `${g.grams >= 1000 ? `${(g.grams / 1000).toFixed(2)} kg` : `${Math.round(g.grams)} g`}` : '—', 'num nowrap');
      cell(tr, g.bad || '—', 'num');
      cell(tr, g.last ? fmtDay(g.last.startedAt) : '—', 'nowrap');
      cell(tr, g.last && !g.last.manual ? reprintButton(g.last.printerId, g.last.file) : '', 'actions');
      return tr;
    }));
    $('totals-empty').hidden = rows.length > 0;

    const done = list.filter((j) => j.outcome === 'completed');
    const bad = list.filter((j) => j.outcome === 'failed' || j.outcome === 'cancelled').length;
    $('t-items').textContent = done.reduce((n, j) => n + j.quantity, 0).toLocaleString();
    $('t-plates').textContent = done.length.toLocaleString();
    $('t-hours').textContent = hours(list.reduce((n, j) => n + (j.outcome === 'printing' ? 0 : j.printSeconds || 0), 0));
    $('t-rate').textContent = done.length + bad ? `${Math.round((done.length / (done.length + bad)) * 100)}%` : '—';
  }

  function render() {
    const list = filtered();
    renderJobs(list);
    renderTotals(list);
    const known = new Map();
    for (const j of jobs) known.set(key(j), j.item);
    $('known-items').replaceChildren(...[...known.values()].map((v) => new Option(v)));
  }

  async function patch(id, body) {
    try { await api(`/api/jobs/${id}`, { method: 'PATCH', body }); }
    catch (err) { toast(err.message, true); }
  }

  // ---- Printer filter + add-past dialog ------------------------------------

  function syncPrinters() {
    const opts = [...cards.values()].map((c) => [c.state.id, c.state.name]);
    for (const sel of [$('f-printer'), document.querySelector('#past-dlg [name=printerId]')]) {
      const cur = sel.value;
      const first = sel.options[0];
      sel.replaceChildren(first, ...opts.map(([v, t]) => new Option(t, v)));
      sel.value = cur;
    }
  }

  function initDialog() {
    const dlg = $('past-dlg');
    const form = dlg.querySelector('form');
    $('add-past').onclick = () => {
      form.reset();
      syncPrinters();
      form.date.value = new Date().toISOString().slice(0, 10);
      dlg.showModal();
    };
    form.file.addEventListener('change', () => {
      // Pre-fill items per plate from the most recent job of that item.
      const hit = jobs.find((j) => j.item.toLowerCase() === form.file.value.trim().toLowerCase() && j.quantitySet);
      if (hit) form.quantity.value = hit.quantity;
    });
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'add') return;
      const body = Object.fromEntries(new FormData(form));
      body.date = body.date ? `${body.date}T12:00:00` : '';
      try {
        await api('/api/jobs', { body });
        toast(`Added ${body.plates} × ${body.file}`);
      } catch (err) { toast(err.message, true); }
    });
  }

  // ---- Public ---------------------------------------------------------------

  function setAll(list) { jobs = list; render(); }
  function upsert(job) {
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) jobs[i] = job; else jobs.unshift(job);
    jobs.sort((a, b) => b.startedAt - a.startedAt);
    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initDialog();
    for (const id of ['f-period', 'f-printer', 'f-search']) $(id).addEventListener('input', render);
  });

  return { setAll, upsert, render, syncPrinters };
})();
