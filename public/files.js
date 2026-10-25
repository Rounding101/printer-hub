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

  async function uploadToPrinter(file) {
    const dlg = $('files-dlg');
    const printerId = filesFor;
    try {
      const res = await upload(`/api/printers/${enc(printerId)}/upload?name=${enc(file.name)}`, file, dlg.querySelector('.progress'));
      toast(`Sent ${res.file} to ${printerName(printerId)}`);
      if (dlg.querySelector('.upload-print').checked) {
        dlg.close();
        openPrint(printerId, res.file);
      } else {
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
    const items = library.filter((i) => !q || i.name.toLowerCase().includes(q) || (i.printerModel || '').toLowerCase().includes(q));
    const printers = [...cards.values()].map((c) => c.state);
    body.replaceChildren(...items.map((i) => {
      const tr = document.createElement('tr');
      const td = (text, cls) => { const el = document.createElement('td'); if (cls) el.className = cls; el.textContent = text ?? ''; tr.append(el); return el; };
      const name = td('', 'item lib-item');
      name.title = [i.name, i.slicer && `Sliced with ${i.slicer}`, i.material, i.estimate && `Est. ${i.estimate}`].filter(Boolean).join('\n');
      const added = new Date(i.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const sent = (i.sentTo || []).map(printerName).join(', ');
      name.append(
        Object.assign(document.createElement('span'), { className: 'lib-name', textContent: i.name }),
        Object.assign(document.createElement('span'), { className: 'lib-sub', textContent: [`Added ${added}`, i.material, sent && `On ${sent}`].filter(Boolean).join(' · ') }),
      );
      td(i.printerModel || '—', 'nowrap');
      td(size(i.size), 'num nowrap');

      const actions = document.createElement('td');
      actions.className = 'actions';
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      const sel = document.createElement('select');
      sel.className = 'small';
      sel.setAttribute('aria-label', 'Printer');
      for (const p of printers) sel.add(new Option(p.name, p.id));
      const sug = suggestPrinter(i);
      if (sug) sel.value = sug.id;
      const send = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: 'Send' });
      const print = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small primary', textContent: 'Print…' });
      const sync = () => {
        const p = cards.get(sel.value)?.state;
        send.disabled = !(p && p.online && p.capabilities?.files);
        print.disabled = !canPrint(p);
        print.title = p && !canPrint(p) ? `${p.name} is ${p.online ? p.status : 'offline'}` : '';
      };
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

  async function addToLibrary(fileList) {
    for (const file of fileList) {
      try {
        await upload(`/api/library?name=${enc(file.name)}`, file, $('lib-progress'));
        toast(`Saved ${file.name} to the library`);
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
  }

  document.addEventListener('DOMContentLoaded', initLibrary);

  function setLibrary(items) { library = items; renderLibrary(); }

  return { openPrinterFiles, openPrint, setLibrary, renderLibrary };
})();
