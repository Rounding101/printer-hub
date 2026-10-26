// Printer files, uploads, the print dialog (filament slot mapping) and the
// hub's file library. Uses api(), toast() and cards from app.js.
const Files = (() => {
  let library = [];
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const rgb = (c) => `rgb(${(c || [0, 0, 0]).slice(0, 3).join(',')})`;
  const size = (b) => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const printerName = (id) => cards.get(id)?.state.name || id;
  const canPrint = (p) => p && p.online && p.capabilities?.files && ['idle', 'completed'].includes(p.status);

  // Raw-body upload with progress (XHR, since fetch has no upload progress).
  function upload(url, file, progressEl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fill = progressEl?.querySelector('.progress-fill');
      const text = progressEl?.querySelector('.progress-text');
      if (progressEl) progressEl.hidden = false;
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable || !progressEl) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = `${pct}%`;
        text.textContent = pct < 100 ? `Uploading ${file.name}… ${pct}%` : `Sending ${file.name} on…`;
      };
      xhr.onload = () => {
        if (progressEl) progressEl.hidden = true;
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => { if (progressEl) progressEl.hidden = true; reject(new Error('Upload failed: network error')); };
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(file);
    });
  }

  // ---- Files on a printer ---------------------------------------------------

  let filesFor = null;

  async function openPrinterFiles(printerId) {
    filesFor = printerId;
    const dlg = $('files-dlg');
    dlg.querySelector('.dlg-name').textContent = printerName(printerId);
    dlg.querySelector('.file-filter').value = '';
    if (!dlg.open) dlg.showModal();
    await loadPrinterFiles();
  }

  async function loadPrinterFiles() {
    const dlg = $('files-dlg');
    const list = dlg.querySelector('.file-list');
    list.innerHTML = '<li class="empty">Loading…</li>';
    try {
      const files = await api(`/api/printers/${enc(filesFor)}/files`);
      list.replaceChildren(...(files.length ? files.map((f) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.title = f.name;
        b.innerHTML = '<span class="fname"></span><span class="fsize"></span>';
        b.firstChild.textContent = f.name;
        b.lastChild.textContent = f.size ? size(f.size) : '';
        b.onclick = () => { dlg.close(); openPrint(filesFor, f.name); };
        li.append(b);
        return li;
      }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No files on the printer yet — upload one above.' })]));
      filterPrinterFiles();
    } catch (err) {
      list.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: err.message }));
    }
  }

  function filterPrinterFiles() {
    const q = $('files-dlg').querySelector('.file-filter').value.trim().toLowerCase();
    $('files-dlg').querySelectorAll('.file-list li').forEach((li) => {
      if (li.classList.contains('empty')) return;
      li.hidden = q && !li.textContent.toLowerCase().includes(q);
    });
  }

  // Uploads to a printer (kept in the library too). From the files dialog by
  // default; the control view passes its own printer, progress bar and mode.
  async function uploadToPrinter(file, printerId = filesFor, opts = {}) {
    const dlg = $('files-dlg');
    const progressEl = opts.progressEl || dlg.querySelector('.progress');
    const printAfter = opts.print ?? dlg.querySelector('.upload-print').checked;
    try {
      const res = await upload(`/api/printers/${enc(printerId)}/upload?name=${enc(file.name)}`, file, progressEl);
      if (res.model) {
        // Models can't be printed directly: slice for this printer first.
        if (dlg.open) dlg.close();
        const item = library.find((i) => i.id === res.libraryId) || { id: res.libraryId, name: res.file };
        lastSlice.printerId = printerId;
        toast(`${res.file} is a model. Saved to the library; slice it to print.`);
        if (slicer.available) openSlice(item);
        return;
      }
      toast(`Sent ${res.file} to ${printerName(printerId)}`);
      if (printAfter) {
        if (dlg.open) dlg.close();
        openPrint(printerId, res.file);
      } else if (dlg.open) {
        loadPrinterFiles();
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---- Print dialog -----------------------------------------------------------

  let printReq = 0;

  async function openPrint(printerId, file) {
    const dlg = $('print-dlg');
    const body = dlg.querySelector('.pd-body');
    const start = dlg.querySelector('.pd-start');
    const req = ++printReq;
    dlg.querySelector('.pd-printer').textContent = printerName(printerId);
    dlg.querySelector('.pd-file').textContent = file;
    body.innerHTML = '<p class="dlg-hint">Loading print options…</p>';
    start.disabled = true;
    dlg.returnValue = '';
    dlg.showModal();

    let opts;
    try {
      opts = await api(`/api/printers/${enc(printerId)}/print-options?file=${enc(file)}`);
    } catch (err) {
      if (req !== printReq) return;
      const lib = library.find((i) => i.name === file);
      body.innerHTML = '';
      body.append(Object.assign(document.createElement('p'), { className: 'err', textContent: err.message }));
      if (lib) {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Send from library first' });
        b.onclick = async () => {
          b.disabled = true;
          try { await sendFromLibrary(lib.id, printerId); openPrint(printerId, file); }
          catch (e) { toast(e.message, true); b.disabled = false; }
        };
        body.append(b);
      }
      return;
    }
    if (req !== printReq) return;

    body.replaceChildren();
    const selects = new Map();
    if (opts.colors.length) {
      const h = Object.assign(document.createElement('p'), { className: 'pd-section', textContent: 'Filament for each color' });
      body.append(h);
      for (const c of opts.colors) {
        const row = document.createElement('div');
        row.className = 'map-row';
        row.innerHTML = `<span class="swatch"></span><span class="map-label"></span><span class="map-arrow">→</span><span class="swatch slot-swatch"></span>`;
        row.children[0].style.background = rgb(c.color);
        row.children[1].textContent = `Color ${c.index + 1} · ${c.material}${c.grams ? ` · ${c.grams.toFixed(1)} g` : ''}`;
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `Slot for color ${c.index + 1}`);
        for (const s of opts.slots) {
          const o = new Option(`Slot ${s.index + 1} · ${s.type}${s.ready ? '' : ' (not loaded)'}`, s.index, false, s.index === c.slot);
          sel.add(o);
        }
        if (c.slot == null) sel.add(new Option('Pick a slot', '', true, true), 0);
        const paintSlot = () => {
          const s = opts.slots.find((x) => String(x.index) === sel.value);
          row.children[3].style.background = s ? rgb(s.color) : 'transparent';
          sel.classList.toggle('warn', !!s && !s.ready);
        };
        sel.onchange = () => { paintSlot(); validate(); };
        paintSlot();
        row.append(sel);
        body.append(row);
        selects.set(c.index, sel);
      }
    }
    const checks = new Map();
    for (const o of opts.options) {
      const label = document.createElement('label');
      label.className = 'check';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!o.default });
      label.append(box, ` ${o.label}`);
      body.append(label);
      checks.set(o.key, box);
    }
    const warn = document.createElement('p');
    warn.className = 'dlg-hint';
    warn.textContent = 'Make sure the bed is clear before starting.';
    body.append(warn);

    function validate() {
      start.disabled = [...selects.values()].some((s) => s.value === '');
    }
    validate();

    dlg.onclose = async () => {
      if (dlg.returnValue !== 'start' || req !== printReq) return;
      const mapping = Object.fromEntries([...selects].map(([k, s]) => [k, Number(s.value)]));
      const payload = { file, mapping, ...Object.fromEntries([...checks].map(([k, b]) => [k, b.checked])) };
      try {
        await api(`/api/printers/${enc(printerId)}/print`, { body: payload });
        toast(`Starting ${file} on ${printerName(printerId)}`);
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---- Library ----------------------------------------------------------------

  async function sendFromLibrary(id, printerId) {
    await api(`/api/library/${enc(id)}/send`, { body: { printerId } });
    toast(`Sent to ${printerName(printerId)}`);
  }

  function suggestPrinter(item) {
    const model = (item.printerModel || '').toLowerCase();
    const all = [...cards.values()].map((c) => c.state);
    return all.find((p) => model && (model.includes((p.model || '').toLowerCase()) || (p.model || '').toLowerCase().includes(model)))
      || all.find((p) => model.includes('kobra') && p.type === 'anycubic')
      || all.find((p) => (model.includes('flashforge') || model.includes('adventurer')) && p.type === 'flashforge')
      || null;
  }

  function renderLibrary() {
    const body = $('lib-body');
    if (!body) return;
    const q = $('lib-search').value.trim().toLowerCase();
    const prints = library.filter((i) => i.kind !== 'model');
    const models = library.filter((i) => i.kind === 'model');
    $('lib-count-print').textContent = prints.length || '';
    $('lib-count-model').textContent = models.length || '';
    renderModels(models.filter((i) => !q || i.name.toLowerCase().includes(q)));
    const items = prints.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.printerModel || '').toLowerCase().includes(q));
    const printers = [...cards.values()].map((c) => c.state);
    body.replaceChildren(...items.map((i) => {
      const tr = document.createElement('tr');
      const td = (text, cls) => { const el = document.createElement('td'); if (cls) el.className = cls; el.textContent = text ?? ''; tr.append(el); return el; };
      const name = td('', 'item lib-item');
      name.title = [i.name, i.slicer && `Sliced with ${i.slicer}`, i.material, i.estimate && `Est. ${i.estimate}`].filter(Boolean).join('\n');
      const added = new Date(i.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const sent = (i.sentTo || []).map(printerName).join(', ');
      const model = i.modelId && library.find((m) => m.id === i.modelId);
      name.append(
        Object.assign(document.createElement('span'), { className: 'lib-name', textContent: i.name }),
        Object.assign(document.createElement('span'), {
          className: 'lib-sub',
          textContent: [
            model ? `Sliced from ${model.name}` : `Added ${added}`,
            i.copies > 1 && `${i.copies} copies`,
            i.material, i.grams && `${Math.round(i.grams)} g`, i.estimate,
            i.bedTemp != null && (i.bedTemp < 45 ? `bed only ${i.bedTemp}°C (${i.bedType || 'plate'}), re-slice` : `bed ${i.bedTemp}°C`),
            sent && `On ${sent}`,
            !i.printerModel && !i.slicedFor && 'Target printer unknown, check before printing',
          ].filter(Boolean).join(' · '),
        }),
      );
      td(i.printerModel || (i.slicedFor ? printerName(i.slicedFor) : '—'), 'nowrap');
      td(size(i.size), 'num nowrap');

      const actions = document.createElement('td');
      actions.className = 'actions';
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      const sel = document.createElement('select');
      sel.className = 'small';
      sel.setAttribute('aria-label', 'Printer');
      // Printers the file wasn't sliced for are listed but can't be picked.
      const fit = (id) => i.fits?.[id] || { ok: true, unknown: true };
      for (const p of printers) {
        const f = fit(p.id);
        const o = new Option(f.ok ? p.name : `${p.name} (sliced for another printer)`, p.id);
        o.disabled = !f.ok;
        sel.add(o);
      }
      const match = printers.find((p) => fit(p.id).ok && !fit(p.id).unknown) || suggestPrinter(i) || printers.find((p) => fit(p.id).ok);
      if (match) sel.value = match.id;
      const send = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Send' });
      const print = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small primary', textContent: 'Print…' });
      const sync = () => {
        const p = cards.get(sel.value)?.state;
        const f = fit(sel.value);
        send.disabled = !f.ok || !(p && p.online && p.capabilities?.files);
        print.disabled = !f.ok || !canPrint(p);
        const why = !f.ok ? `This file ${f.reason}` : p && !canPrint(p) ? `${p.name} is ${p.online ? p.status : 'offline'}` : '';
        print.title = send.title = why;
      };
      if (!printers.some((p) => fit(p.id).ok)) sel.disabled = true;
      sel.onchange = sync;
      sync();
      send.onclick = async () => {
        send.disabled = true;
        try { await sendFromLibrary(i.id, sel.value); } catch (err) { toast(err.message, true); }
        sync();
      };
      print.onclick = async () => {
        print.disabled = true;
        try {
          if (!(i.sentTo || []).includes(sel.value)) await sendFromLibrary(i.id, sel.value);
          openPrint(sel.value, i.name);
        } catch (err) { toast(err.message, true); }
        sync();
      };
      const dl = Object.assign(document.createElement('a'), { className: 'btn small ghost icon', textContent: '⤓', title: 'Download', href: `/api/library/${enc(i.id)}/download` });
      dl.setAttribute('aria-label', `Download ${i.name}`);
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✕', title: 'Delete from library' });
      del.setAttribute('aria-label', `Delete ${i.name}`);
      del.onclick = async () => {
        if (!confirm(`Delete ${i.name} from the hub library? Copies already on printers stay there.`)) return;
        try { await api(`/api/library/${enc(i.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
      };
      wrap.append(sel, send, print, dl, del);
      actions.append(wrap);
      tr.append(actions);
      return tr;
    }));
    $('lib-empty').hidden = items.length > 0;
  }

  // ---- Models -------------------------------------------------------------------

  let slicer = { available: false, printers: [] };

  async function refreshSlicer() {
    try { slicer = await api('/api/slicer'); } catch { slicer = { available: false, printers: [] }; }
    const el = $('slicer-status');
    const v = slicer.version && slicer.version !== 'unknown' ? ` ${slicer.version}` : '';
    el.textContent = slicer.available ? `Slicer ready · OrcaSlicer${v}` : 'Slicer offline';
    el.classList.toggle('off', !slicer.available);
    el.title = slicer.error || '';
    renderLibrary();
  }

  function renderModels(models) {
    const body = $('model-body');
    body.replaceChildren(...models.map((m) => {
      const tr = document.createElement('tr');
      const slices = library.filter((i) => i.modelId === m.id);
      const name = document.createElement('td');
      name.className = 'item lib-item';
      name.append(
        Object.assign(document.createElement('span'), { className: 'lib-name', textContent: m.name }),
        Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: `Added ${new Date(m.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` }),
      );
      const sl = document.createElement('td');
      sl.className = 'nowrap';
      sl.textContent = slices.length
        ? [...new Set(slices.map((s) => printerName(s.slicedFor)))].map((p) => `${p} (${slices.filter((s) => printerName(s.slicedFor) === p).length})`).join(', ')
        : '—';
      const sz = Object.assign(document.createElement('td'), { className: 'num nowrap', textContent: size(m.size) });
      const actions = document.createElement('td');
      actions.className = 'actions';
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      if (window.Preview?.supports(m.name)) {
        const pv = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Preview' });
        pv.onclick = () => window.Preview.open(m);
        wrap.append(pv);
      }
      const go = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small primary', textContent: 'Slice…' });
      go.disabled = !slicer.available;
      go.title = slicer.available ? '' : 'The slicer service is not running';
      go.onclick = () => openSlice(m);
      const dl = Object.assign(document.createElement('a'), { className: 'btn small ghost icon', textContent: '⤓', title: 'Download', href: `/api/library/${enc(m.id)}/download` });
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small ghost icon', textContent: '✕', title: 'Delete model' });
      del.onclick = async () => {
        if (!confirm(`Delete ${m.name}? Its sliced print files stay in the library.`)) return;
        try { await api(`/api/library/${enc(m.id)}`, { method: 'DELETE' }); } catch (err) { toast(err.message, true); }
      };
      wrap.append(go, dl, del);
      actions.append(wrap);
      tr.append(name, sl, sz, actions);
      return tr;
    }));
    $('model-empty').hidden = models.length > 0;
  }

  function showLibPanel(kind) {
    document.querySelectorAll('[data-lib]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.lib === kind)));
    document.querySelectorAll('[data-lib-panel]').forEach((p) => { p.hidden = p.dataset.libPanel !== kind; });
    try { localStorage.setItem('libPanel', kind); } catch { /* storage unavailable */ }
  }

  // ---- Slice dialog ---------------------------------------------------------------

  const lastSlice = (() => { try { return JSON.parse(localStorage.getItem('lastSlice') || '{}'); } catch { return {}; } })();

  async function openSlice(model) {
    const dlg = $('slice-dlg');
    const f = dlg.querySelector('form');
    const status = dlg.querySelector('.sd-status');
    const go = dlg.querySelector('.sd-go');
    dlg.querySelector('.sd-model').textContent = model.name;
    dlg.querySelector('.sd-fields').hidden = false;
    status.hidden = true;
    go.hidden = false;
    go.disabled = false;
    go.textContent = 'Slice';
    dlg.querySelector('.sd-close').textContent = 'Cancel';

    const printers = [...cards.values()].map((c) => c.state).filter((p) => slicer.printers.includes(p.id));
    f.printerId.replaceChildren(...printers.map((p) => new Option(p.name, p.id)));
    if (lastSlice.printerId && printers.some((p) => p.id === lastSlice.printerId)) f.printerId.value = lastSlice.printerId;
    f.copies.value = lastSlice.copies || 1;
    f.infill.value = lastSlice.infill ?? 15;
    f.supports.value = lastSlice.supports || 'off';
    f.walls.value = lastSlice.walls || 2;
    f.brim.checked = !!lastSlice.brim;
    f.orient.checked = !!lastSlice.orient;
    const infillLabel = () => { dlg.querySelector('.sd-infill-val').textContent = `${f.infill.value}%`; };
    f.infill.oninput = infillLabel;
    infillLabel();

    const loadProfiles = async () => {
      f.process.replaceChildren(new Option('Loading…', ''));
      f.filament.replaceChildren(new Option('Loading…', ''));
      try {
        const pr = await api(`/api/slicer/profiles?printerId=${enc(f.printerId.value)}`);
        const pick = (sel, names, def, remembered) => {
          sel.replaceChildren(...names.map((n) => new Option(n.replace(/ @.*$/, ''), n)));
          sel.value = names.includes(remembered) ? remembered : def;
        };
        const mem = lastSlice.byPrinter?.[f.printerId.value] || {};
        pick(f.process, pr.processes, pr.defaults.process, mem.process);
        pick(f.filament, pr.filaments, pr.defaults.filament, mem.filament);
        const beds = pr.bedTypes || [];
        f.bedType.replaceChildren(...beds.map((b) => new Option(b.label, b.value)));
        f.bedType.value = beds.some((b) => b.value === mem.bedType) ? mem.bedType : (pr.defaults.bedType || beds[0]?.value || '');
      } catch (err) {
        f.process.replaceChildren(new Option(err.message, ''));
        f.filament.replaceChildren();
      }
    };
    f.printerId.onchange = loadProfiles;
    dlg.showModal();
    await loadProfiles();

    go.onclick = async () => {
      if (!f.process.value || !f.filament.value) return;
      const printerId = f.printerId.value;
      const body = {
        printerId,
        process: f.process.value,
        filament: f.filament.value,
        bedType: f.bedType.value || undefined,
        copies: Number(f.copies.value) || 1,
        orient: f.orient.checked,
        options: { infill: Number(f.infill.value), supports: f.supports.value, brim: f.brim.checked, walls: Number(f.walls.value) || 2 },
      };
      Object.assign(lastSlice, { printerId, copies: body.copies, infill: body.options.infill, supports: body.options.supports, brim: body.options.brim, walls: body.options.walls, orient: body.orient });
      lastSlice.byPrinter = { ...(lastSlice.byPrinter || {}), [printerId]: { process: body.process, filament: body.filament, bedType: body.bedType } };
      try { localStorage.setItem('lastSlice', JSON.stringify(lastSlice)); } catch { /* storage unavailable */ }

      go.disabled = true;
      go.textContent = 'Slicing…';
      status.hidden = false;
      status.className = 'sd-status';
      status.textContent = `Slicing ${body.copies > 1 ? `${body.copies} copies ` : ''}for ${printerName(printerId)}. Large models can take a few minutes.`;
      try {
        const item = await api(`/api/library/${enc(model.id)}/slice`, { body });
        dlg.querySelector('.sd-fields').hidden = true;
        status.className = 'sd-status ok';
        status.replaceChildren(
          Object.assign(document.createElement('strong'), { textContent: 'Sliced' }),
          document.createTextNode(` ${[item.estimate, item.grams && `${Math.round(item.grams)} g`, `${item.copies} ${item.copies === 1 ? 'copy' : 'copies'}`].filter(Boolean).join(' · ')}`),
          Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: [item.bedTemp != null && `Bed ${item.bedTemp}°C`, item.nozzleTemp && `nozzle ${item.nozzleTemp}°C`, item.bedType].filter(Boolean).join(' · ') }),
          Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: item.name }),
        );
        if (item.bedTemp != null && item.bedTemp < 45) {
          status.append(Object.assign(document.createElement('span'), { className: 'err', textContent: `Heads up: the bed only heats to ${item.bedTemp}°C on this plate setting.` }));
        }
        go.hidden = true;
        dlg.querySelector('.sd-close').textContent = 'Done';
        const print = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Send & print…' });
        const p = cards.get(printerId)?.state;
        print.disabled = !canPrint(p);
        print.title = p && !canPrint(p) ? `${p.name} is ${p.online ? p.status : 'offline'}` : '';
        print.onclick = async () => {
          print.disabled = true;
          try {
            await sendFromLibrary(item.id, printerId);
            dlg.close();
            openPrint(printerId, item.name);
          } catch (err) { toast(err.message, true); print.disabled = false; }
        };
        status.append(print);
      } catch (err) {
        status.className = 'sd-status bad';
        status.textContent = err.message;
        go.disabled = false;
        go.textContent = 'Slice';
      }
    };
  }

  async function addToLibrary(fileList) {
    for (const file of fileList) {
      try {
        const item = await upload(`/api/library?name=${enc(file.name)}`, file, $('lib-progress'));
        toast(`Saved ${file.name} to ${item.kind === 'model' ? 'Models' : 'Print files'}`);
        showLibPanel(item.kind === 'model' ? 'model' : 'print');
      } catch (err) { toast(`${file.name}: ${err.message}`, true); }
    }
  }

  function initLibrary() {
    const drop = $('lib-drop');
    $('lib-input').addEventListener('change', (e) => { addToLibrary([...e.target.files]); e.target.value = ''; });
    $('lib-search').addEventListener('input', renderLibrary);
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => addToLibrary([...e.dataTransfer.files]));

    const fdlg = $('files-dlg');
    fdlg.querySelector('.upload-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) uploadToPrinter(f);
    });
    fdlg.querySelector('.file-filter').addEventListener('input', filterPrinterFiles);
    fdlg.querySelector('.lib-link').addEventListener('click', () => fdlg.close());

    document.querySelectorAll('[data-lib]').forEach((b) => b.addEventListener('click', () => showLibPanel(b.dataset.lib)));
    let saved = 'print';
    try { saved = localStorage.getItem('libPanel') || 'print'; } catch { /* storage unavailable */ }
    showLibPanel(saved);
    refreshSlicer();
    setInterval(refreshSlicer, 60000);
  }

  document.addEventListener('DOMContentLoaded', initLibrary);

  function setLibrary(items) { library = items; renderLibrary(); }

  return { openPrinterFiles, openPrint, setLibrary, renderLibrary, uploadToPrinter };
})();
