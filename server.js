const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { FlashForgeDriver } = require('./drivers/flashforge');
const { AnycubicDriver } = require('./drivers/anycubic');
const { MockDriver } = require('./drivers/mock');
const { JobLog } = require('./lib/jobs');
const { Library } = require('./lib/library');
const { checkFile } = require('./lib/compat');

const DRIVERS = { flashforge: FlashForgeDriver, anycubic: AnycubicDriver, mock: MockDriver };

// ---- Config ------------------------------------------------------------------

const argIdx = process.argv.indexOf('--config');
const configPath = path.resolve(__dirname, argIdx > -1 ? process.argv[argIdx + 1] : process.env.CONFIG_PATH || 'config.json');
if (!fs.existsSync(configPath)) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), configPath);
  console.log(`Created ${path.basename(configPath)} from the example — edit it with your printer IPs.`);
}
// "${NAME}" in config values is replaced by the NAME environment variable, so
// secrets like check codes can come from the environment (e.g. Docker).
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'), (_key, value) => {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_m, name) => {
    if (process.env[name] == null) console.warn(`Config references unset environment variable ${name}`);
    return process.env[name] ?? '';
  });
});
const port = Number(process.env.PORT) || config.port || 3000;

const printers = new Map();
for (const cfg of config.printers || []) {
  const Driver = DRIVERS[cfg.type];
  if (!Driver) { console.warn(`Skipping ${cfg.id}: unknown type "${cfg.type}"`); continue; }
  printers.set(cfg.id, new Driver(cfg, { pollIntervalMs: config.pollIntervalMs }));
}

// Job log lives next to the config, e.g. data/ for config.json, data-demo/ for the demo.
const dataDir = process.env.DATA_DIR || config.dataDir
  ? path.resolve(__dirname, process.env.DATA_DIR || config.dataDir)
  : path.join(__dirname, path.basename(configPath) === 'config.json' ? 'data' : `data-${path.basename(configPath, '.json').replace(/^config\.?/, '') || 'alt'}`);
const jobs = new JobLog(dataDir);
const library = new Library(dataDir);

// ---- Live updates (Server-Sent Events) ---------------------------------------

const clients = new Set();
const snapshot = () => [...printers.values()].map((p) => p.state);
const broadcast = (event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
};

for (const driver of printers.values()) {
  driver.on('update', (state) => {
    jobs.observe(state);
    broadcast('printer', state);
  });
}
jobs.on('job', (job) => broadcast('job', job));
jobs.on('reset', () => broadcast('jobs', jobs.list()));
library.on('change', () => broadcast('library', libraryView()));

// Refuses print files sliced for a different printer.
function assertFits(item, printer) {
  const fit = checkFile(item, printer.cfg, printer.state.name);
  if (!fit.ok) throw new Error(`${item.name} ${fit.reason}. Slice it for this printer instead.`);
}

// Library entries as sent to the browser, with per-printer compatibility.
const libraryView = () => library.list().map((i) => (i.kind === 'model' ? i : {
  ...i,
  fits: Object.fromEntries([...printers.values()].map((p) => {
    const f = checkFile(i, p.cfg, p.state.name);
    return [p.state.id, { ok: f.ok, unknown: !!f.unknown, reason: f.reason || null }];
  })),
}));

// Sends a library file to a printer's own storage.
async function sendToPrinter(item, printer) {
  if (item.kind === 'model') throw new Error(`${item.name} is a model; slice it first`);
  assertFits(item, printer);
  await printer.upload(item.name, library.read(item.id));
  library.markSent(item.id, printer.state.id);
}

// New jobs default their item count to the number of copies the hub sliced.
jobs.quantityHint = (file) => library.findByName(file)?.copies ?? null;

// ---- Slicer service (OrcaSlicer CLI in its own container) ---------------------

const SLICER_URL = process.env.SLICER_URL || config.slicerUrl || null;
// Orca vendor/machine presets per printer type; a printer can override with "slicer".
const SLICER_DEFAULTS = {
  anycubic: { vendor: 'Anycubic', machine: 'Anycubic Kobra X 0.4 nozzle' },
  flashforge: { vendor: 'Flashforge', machine: 'Flashforge Adventurer 5M 0.4 Nozzle' },
};
const slicerProfileFor = (p) => p.cfg.slicer || SLICER_DEFAULTS[p.cfg.type] || null;

async function slicerCall(pathname, body, timeoutMs = 10000) {
  if (!SLICER_URL) throw new Error('No slicer service configured');
  const res = await fetch(new URL(pathname, SLICER_URL), {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Slicer error ${res.status}`);
  return data;
}

let slicerStatus = { available: false, checkedAt: 0 };
async function slicerHealth() {
  if (!SLICER_URL) return { available: false };
  if (Date.now() - slicerStatus.checkedAt < 30000) return slicerStatus;
  try {
    const h = await slicerCall('/health', null, 3000);
    slicerStatus = { available: true, version: h.version, busy: h.busy, checkedAt: Date.now() };
  } catch (err) {
    slicerStatus = { available: false, error: err.message, checkedAt: Date.now() };
  }
  return slicerStatus;
}

const tag = (s) => String(s).replace(/[^A-Za-z0-9.+-]+/g, '_').replace(/^_+|_+$/g, '');

async function sliceModel(item, printer, body) {
  const profile = slicerProfileFor(printer);
  if (!profile) throw new Error(`No slicer profile for ${printer.state.name}`);
  const copies = Math.max(1, Math.min(64, Math.round(Number(body.copies) || 1)));
  const result = await slicerCall('/slice', {
    input: library.filePath(item),
    vendor: profile.vendor,
    machine: profile.machine,
    process: body.process,
    filament: body.filament,
    copies,
    orient: !!body.orient,
    options: body.options || {},
    paintInfo: printer.cfg.type === 'anycubic',
  }, 25 * 60 * 1000);
  try {
    const layer = (/^(\d+\.\d+mm)/.exec(body.process || '') || [])[1] || 'custom';
    const material = tag((result.stats.material || 'PLA').split(';')[0]);
    const base = tag(item.name.replace(/\.[^.]+$/, ''));
    const name = `${base}_${tag(printer.state.id)}_${layer}_${material}${copies > 1 ? `_x${copies}` : ''}.gcode`;
    return await library.addFromStream(name, fs.createReadStream(result.output), {
      modelId: item.id,
      copies,
      slicedFor: printer.state.id,
      sliceSettings: { process: body.process, filament: body.filament, options: body.options || {} },
      grams: result.stats.grams,
      estimate: result.stats.time,
    });
  } finally {
    slicerCall('/cleanup', { id: result.id }).catch(() => {});
  }
}

// ---- HTTP helpers ------------------------------------------------------------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// Pipes an upstream camera/image URL through to the browser, so the page never
// needs direct access to printer ports (and works from outside the LAN via this host).
function proxy(req, res, source, { timeoutMs = 8000 } = {}) {
  if (!source) return json(res, 404, { error: 'Not available' });
  const lib = source.url.startsWith('https') ? https : http;
  const upstream = lib.get(source.url, { headers: source.headers || {}, rejectUnauthorized: false }, (up) => {
    const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (up.headers['content-type']) headers['Content-Type'] = up.headers['content-type'];
    if (up.headers['content-length']) headers['Content-Length'] = up.headers['content-length'];
    res.writeHead(up.statusCode || 502, headers);
    up.pipe(res);
    upstream.setTimeout(0);
  });
  upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) json(res, 502, { error: err.message });
    else res.destroy();
  });
  req.on('close', () => upstream.destroy());
}

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/jobs.js': ['public/jobs.js', 'text/javascript; charset=utf-8'],
  '/files.js': ['public/files.js', 'text/javascript; charset=utf-8'],
  '/preview.js': ['public/preview.js', 'text/javascript; charset=utf-8'],
  '/control.js': ['public/control.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/vendor/mpegts.js': ['node_modules/mpegts.js/dist/mpegts.js', 'text/javascript; charset=utf-8'],
};

// ---- Routes ------------------------------------------------------------------

const ACTIONS = {
  pause: (p) => p.pause(),
  resume: (p) => p.resume(),
  cancel: (p) => p.cancel(),
  light: (p, body) => p.setLight(!!body.on),
  control: (p, body) => p.control(body),
  slots: (p) => (p.refreshSlots ? p.refreshSlots() : p.state.slots),
  print: (p, body) => {
    if (!body.file) throw new Error('file is required');
    // Files the library knows are checked here; drivers check what the printer
    // itself reports (e.g. the Kobra X's per-file printer_model).
    const known = library.findByName(String(body.file));
    if (known && known.kind !== 'model') assertFits(known, p);
    return p.startPrint(String(body.file), { mapping: body.mapping, autoLevel: body.autoLevel });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // three.js for the model preview: /vendor/three/three.module.js and /vendor/three/addons/...
  if (req.method === 'GET' && url.pathname.startsWith('/vendor/three/')) {
    const rel = url.pathname.slice('/vendor/three/'.length);
    const root = rel.startsWith('addons/') ? path.join(__dirname, 'node_modules/three/examples/jsm') : path.join(__dirname, 'node_modules/three/build');
    const file = path.resolve(root, rel.replace(/^addons\//, ''));
    if (!file.startsWith(root + path.sep) || !file.endsWith('.js')) return json(res, 404, { error: 'Not found' });
    return fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    });
  }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    return fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': type });
      res.end(buf);
    });
  }

  if (parts[0] !== 'api') return json(res, 404, { error: 'Not found' });

  if (url.pathname === '/api/printers' && req.method === 'GET') return json(res, 200, snapshot());

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    res.write(`event: jobs\ndata: ${JSON.stringify(jobs.list())}\n\n`);
    res.write(`event: library\ndata: ${JSON.stringify(libraryView())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }

  // /api/jobs, /api/jobs/:id, /api/jobs.csv
  if (url.pathname === '/api/jobs.csv' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="print-jobs.csv"' });
    return res.end(jobs.csv());
  }
  if (parts[1] === 'jobs') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, jobs.list());
      if (!parts[2] && req.method === 'POST') {
        const body = await readBody(req);
        const p = body.printerId && printers.get(body.printerId);
        jobs.addManual({ ...body, printerName: p ? p.state.name : undefined });
        return json(res, 200, { ok: true });
      }
      if (parts[2] && req.method === 'PATCH') return json(res, 200, jobs.edit(parts[2], await readBody(req)));
      if (parts[2] && req.method === 'DELETE') { jobs.remove(parts[2]); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/slicer, /api/slicer/profiles?printerId=
  if (parts[1] === 'slicer') {
    try {
      if (!parts[2]) {
        const h = await slicerHealth();
        const supported = [...printers.values()].filter((p) => slicerProfileFor(p)).map((p) => p.state.id);
        return json(res, 200, { available: h.available, version: h.version || null, error: h.error || null, printers: supported });
      }
      if (parts[2] === 'profiles') {
        const p = printers.get(url.searchParams.get('printerId'));
        if (!p) throw new Error('Unknown printer');
        const profile = slicerProfileFor(p);
        if (!profile) throw new Error(`No slicer profile for ${p.state.name}`);
        return json(res, 200, await slicerCall(`/profiles?vendor=${encodeURIComponent(profile.vendor)}&machine=${encodeURIComponent(profile.machine)}`));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/library, /api/library/:id[/download|/send|/slice]
  if (parts[1] === 'library') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, libraryView());
      if (!parts[2] && req.method === 'POST') {
        return json(res, 200, await library.addFromStream(url.searchParams.get('name'), req));
      }
      const item = library.get(parts[2]);
      if (parts[3] === 'download' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': item.size,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        });
        return fs.createReadStream(library.filePath(item)).pipe(res);
      }
      if (parts[3] === 'slice' && req.method === 'POST') {
        const body = await readBody(req);
        const p = printers.get(body.printerId);
        if (!p) throw new Error('Unknown printer');
        if (item.kind !== 'model') throw new Error('Only models can be sliced');
        return json(res, 200, await sliceModel(item, p, body));
      }
      if (parts[3] === 'send' && req.method === 'POST') {
        const body = await readBody(req);
        const p = printers.get(body.printerId);
        if (!p) throw new Error('Unknown printer');
        await sendToPrinter(item, p);
        return json(res, 200, { ok: true, file: item.name });
      }
      if (!parts[3] && req.method === 'DELETE') { library.remove(item.id); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // /api/printers/:id/:resource
  const printer = parts[1] === 'printers' && printers.get(parts[2]);
  if (!printer) return json(res, 404, { error: 'Unknown printer' });
  const resource = parts[3];

  try {
    if (req.method === 'GET') {
      if (resource === 'camera') {
        if (printer.serveCamera) return printer.serveCamera(req, res);
        return proxy(req, res, printer.cameraSource());
      }
      if (resource === 'snapshot') return proxy(req, res, printer.snapshotSource());
      if (resource === 'thumb') return proxy(req, res, printer.thumbSource());
      if (resource === 'files') return json(res, 200, await printer.listFiles());
      if (resource === 'print-options') return json(res, 200, await printer.printOptions(String(url.searchParams.get('file') || '')));
    }
    // Upload from the browser: kept in the library, then sent to the printer.
    if (req.method === 'POST' && resource === 'upload') {
      const item = await library.addFromStream(url.searchParams.get('name'), req);
      if (item.kind === 'model') return json(res, 200, { ok: true, model: true, file: item.name, libraryId: item.id });
      try {
        await sendToPrinter(item, printer);
      } catch (err) {
        throw new Error(`Saved to the library, but the printer didn't take it: ${err.message}`);
      }
      return json(res, 200, { ok: true, file: item.name, libraryId: item.id });
    }
    if (req.method === 'POST' && ACTIONS[resource]) {
      await ACTIONS[resource](printer, await readBody(req));
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(port, () => {
  console.log(`Printer Hub running at http://localhost:${port}`);
  for (const p of printers.values()) {
    console.log(`  - ${p.state.name} (${p.cfg.type}${p.cfg.host ? ' @ ' + p.cfg.host : ''})`);
    p.start();
  }
});

process.on('SIGINT', async () => {
  await Promise.all([...printers.values()].map((p) => p.stop()));
  process.exit(0);
});
