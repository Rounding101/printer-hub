const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { FlashForgeDriver } = require('./drivers/flashforge');
const { AnycubicDriver } = require('./drivers/anycubic');
const { MockDriver } = require('./drivers/mock');
const { JobLog } = require('./lib/jobs');
const { Library } = require('./lib/library');

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
library.on('change', (items) => broadcast('library', items));

// Sends a library file to a printer's own storage.
async function sendToPrinter(item, printer) {
  await printer.upload(item.name, library.read(item.id));
  library.markSent(item.id, printer.state.id);
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
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/vendor/mpegts.js': ['node_modules/mpegts.js/dist/mpegts.js', 'text/javascript; charset=utf-8'],
};

// ---- Routes ------------------------------------------------------------------

const ACTIONS = {
  pause: (p) => p.pause(),
  resume: (p) => p.resume(),
  cancel: (p) => p.cancel(),
  light: (p, body) => p.setLight(!!body.on),
  print: (p, body) => {
    if (!body.file) throw new Error('file is required');
    return p.startPrint(String(body.file), { mapping: body.mapping, autoLevel: body.autoLevel });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

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
    res.write(`event: library\ndata: ${JSON.stringify(library.list())}\n\n`);
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

  // /api/library, /api/library/:id[/download|/send]
  if (parts[1] === 'library') {
    try {
      if (!parts[2] && req.method === 'GET') return json(res, 200, library.list());
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
