// Minimal fake printer APIs for the driver tests, following each API's docs:
// Moonraker, OctoPrint and PrusaLink (with real HTTP Digest auth).
const http = require('node:http');
const crypto = require('node:crypto');

const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
// The file name from a multipart body (enough for these fakes).
const multipartName = (buf) => (/filename="([^"]+)"/.exec(buf.toString('latin1')) || [])[1];

function listen(handler, port = 0) {
  const server = http.createServer((req, res) => handler(req, res).catch((e) => send(res, 500, { error: e.message })));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, host: `127.0.0.1:${server.address().port}` })));
}

// ---- Moonraker -----------------------------------------------------------------

async function fakeMoonraker({ apiKey, port } = {}) {
  const p = {
    state: 'standby', filename: '', progress: 0, duration: 0, light: 0,
    ext: { temperature: 24, target: 0 }, bed: { temperature: 23, target: 0 },
    files: [{ path: 'cube.gcode', modified: 2, size: 1000 }, { path: 'old/part.gcode', modified: 1, size: 500 }],
    gcode: [], calls: [],
  };
  const fake = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    p.calls.push(`${req.method} ${url.pathname}`);
    if (apiKey && req.headers['x-api-key'] !== apiKey) return send(res, 401, { error: { message: 'Unauthorized' } });
    const ok = (result) => send(res, 200, { result });
    switch (url.pathname) {
      case '/printer/info': return ok({ state: 'ready', hostname: 'voron', software_version: 'v0.12.0' });
      case '/printer/objects/query': {
        const status = {
          webhooks: { state: 'ready', state_message: 'Printer is ready' },
          print_stats: { state: p.state, filename: p.filename, print_duration: p.duration, message: '', info: { current_layer: Math.round(p.progress * 100), total_layer: 100 } },
          virtual_sdcard: { progress: p.progress },
          display_status: { progress: p.progress },
          extruder: p.ext, heater_bed: p.bed, fan: { speed: 0.5 }, gcode_move: { speed_factor: 1.25 },
        };
        if (url.search.includes('output_pin%20caselight') || url.search.includes('output_pin caselight')) status['output_pin caselight'] = { value: p.light };
        return ok({ eventtime: 1, status });
      }
      case '/server/files/metadata': return ok({ estimated_time: 3600, thumbnails: [{ width: 32, relative_path: '.thumbs/cube-32x32.png' }, { width: 300, relative_path: '.thumbs/cube-300x300.png' }] });
      case '/server/files/list': return ok(p.files);
      case '/server/webcams/list': return ok({ webcams: [{ name: 'cam', enabled: true, stream_url: '/webcam/?action=stream', snapshot_url: '/webcam/?action=snapshot' }] });
      case '/printer/print/start': Object.assign(p, { state: 'printing', filename: url.searchParams.get('filename'), progress: 0.25, duration: 900 }); return ok('ok');
      case '/printer/print/pause': p.state = 'paused'; return ok('ok');
      case '/printer/print/resume': p.state = 'printing'; return ok('ok');
      case '/printer/print/cancel': p.state = 'cancelled'; return ok('ok');
      case '/printer/gcode/script': {
        const script = url.searchParams.get('script');
        p.gcode.push(script);
        const pin = /SET_PIN PIN=caselight VALUE=(\d)/.exec(script);
        if (pin) p.light = Number(pin[1]);
        return ok('ok');
      }
      case '/server/files/upload': {
        const name = multipartName(await readBody(req));
        p.files.push({ path: name, modified: 3, size: 10 });
        return send(res, 201, { result: { item: { path: name, root: 'gcodes' }, action: 'create_file' } });
      }
      default: return send(res, 404, { error: { message: 'Not found' } });
    }
  }, port);
  return { ...fake, p };
}

// ---- OctoPrint -----------------------------------------------------------------

async function fakeOctoPrint({ apiKey = 'KEY', port } = {}) {
  const p = {
    connected: true, flags: 'ready', file: null, completion: null,
    tool0: { actual: 25, target: 0 }, bed: { actual: 24, target: 0 },
    files: [{ type: 'machinecode', path: 'benchy.gcode', name: 'benchy.gcode', size: 2000, date: 5, gcodeAnalysis: { estimatedPrintTime: 4000 } },
      { type: 'folder', path: 'parts', children: [{ type: 'machinecode', path: 'parts/clip.gcode', name: 'clip.gcode', size: 100, date: 9 }] }],
    commands: [], bodies: [],
  };
  const flags = () => ({
    operational: true, ready: p.flags === 'ready', printing: p.flags === 'printing', paused: p.flags === 'paused',
    pausing: false, cancelling: false, error: false, closedOrError: false,
  });
  const fake = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.headers['x-api-key'] !== apiKey) return send(res, 403, { error: 'Invalid API key' });
    const raw = await readBody(req);
    const body = /json/.test(req.headers['content-type'] || '') && raw.length ? JSON.parse(raw) : null;
    if (body) p.bodies.push({ path: url.pathname, body });
    if (url.pathname === '/api/version') return send(res, 200, { api: '0.1', server: '1.10.2' });
    if (url.pathname === '/api/settings') return send(res, 200, { webcam: { webcamEnabled: true, streamUrl: '/webcam/?action=stream', snapshotUrl: 'http://cam.local/snap' } });
    if (url.pathname === '/api/printer' && req.method === 'GET') {
      if (!p.connected) return send(res, 409, { error: 'Printer is not operational' });
      return send(res, 200, { state: { text: p.flags, flags: flags() }, temperature: { tool0: p.tool0, bed: p.bed } });
    }
    if (url.pathname === '/api/job' && req.method === 'GET') {
      return send(res, 200, {
        job: { file: p.file ? { name: p.file.split('/').pop(), path: p.file, origin: 'local' } : { name: null } },
        progress: { completion: p.completion, printTime: p.file ? 600 : null, printTimeLeft: p.file ? 3000 : null },
        state: p.flags,
      });
    }
    if (url.pathname === '/api/job' && req.method === 'POST') {
      if (body.command === 'pause') p.flags = body.action === 'resume' ? 'printing' : 'paused';
      if (body.command === 'cancel') Object.assign(p, { flags: 'ready', completion: 40 });
      return send(res, 204);
    }
    if (url.pathname === '/api/files/local' && req.method === 'GET') return send(res, 200, { files: p.files });
    if (url.pathname === '/api/files/local' && req.method === 'POST') {
      const name = multipartName(raw);
      p.files.push({ type: 'machinecode', path: name, name, size: 1, date: 10 });
      return send(res, 201, { done: true, files: { local: { name, origin: 'local' } } });
    }
    if (url.pathname.startsWith('/api/files/local/') && req.method === 'POST') {
      Object.assign(p, { file: decodeURIComponent(url.pathname.slice('/api/files/local/'.length)), flags: 'printing', completion: 12.5 });
      return send(res, 204);
    }
    if (['/api/printer/printhead', '/api/printer/tool', '/api/printer/bed'].includes(url.pathname)) return send(res, 204);
    if (url.pathname === '/api/printer/command') { p.commands.push(...body.commands); return send(res, 204); }
    return send(res, 404, { error: 'Not found' });
  }, port);
  return { ...fake, p };
}

// ---- PrusaLink (HTTP Digest) ---------------------------------------------------

async function fakePrusaLink({ user = 'maker', password = 'secret', port } = {}) {
  const realm = 'Printer API';
  const nonce = crypto.randomBytes(8).toString('hex');
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const p = {
    state: 'IDLE', job: null, files: [{ name: 'SHAPE~1.BGC', display_name: 'shape.bgcode', type: 'PRINT_FILE', m_timestamp: 5, size: 300 }],
    uploads: [], authFailures: 0,
  };
  const authorized = (req) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Digest ')) return false;
    const kv = Object.fromEntries([...h.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]));
    const expected = md5(`${md5(`${user}:${realm}:${password}`)}:${kv.nonce}:${kv.nc}:${kv.cnonce}:${kv.qop}:${md5(`${req.method}:${kv.uri}`)}`);
    return kv.username === user && kv.nonce === nonce && kv.response === expected;
  };
  const fake = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!authorized(req)) {
      p.authFailures++;
      return send(res, 401, { title: 'Unauthorized' }, { 'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="auth"` });
    }
    const raw = await readBody(req);
    if (url.pathname === '/api/version') return send(res, 200, { api: '2.0.0', hostname: 'MK4', firmware: '6.1.3' });
    if (url.pathname === '/api/v1/status') {
      return send(res, 200, {
        printer: { state: p.state, temp_nozzle: 215, target_nozzle: 215, temp_bed: 60, target_bed: 60 },
        storage: { path: '/usb/', name: 'usb' },
        ...(p.job ? { job: { id: p.job.id, progress: 30, time_remaining: 1200, time_printing: 500 } } : {}),
      });
    }
    if (url.pathname === '/api/v1/job') {
      if (!p.job) return send(res, 204);
      return send(res, 200, { id: p.job.id, state: p.state, progress: 30, time_remaining: 1200, time_printing: 500, file: { name: p.job.file, display_name: p.job.file, refs: { thumbnail: '/thumb/l/usb/SHAPE~1.BGC' } } });
    }
    const jobAct = /^\/api\/v1\/job\/(\d+)(?:\/(pause|resume))?$/.exec(url.pathname);
    if (jobAct) {
      if (Number(jobAct[1]) !== p.job?.id) return send(res, 409, {});
      if (req.method === 'DELETE') { p.state = 'STOPPED'; p.job = null; } else p.state = jobAct[2] === 'pause' ? 'PAUSED' : 'PRINTING';
      return send(res, 204);
    }
    if (url.pathname === '/api/v1/files/usb') return send(res, 200, { type: 'FOLDER', children: p.files });
    const file = /^\/api\/v1\/files\/usb\/(.+)$/.exec(url.pathname);
    if (file && req.method === 'PUT') { p.uploads.push({ name: decodeURIComponent(file[1]), size: raw.length, printAfter: req.headers['print-after-upload'] }); return send(res, 201); }
    if (file && req.method === 'POST') { p.state = 'PRINTING'; p.job = { id: 42, file: decodeURIComponent(file[1]) }; return send(res, 204); }
    return send(res, 404, {});
  }, port);
  return { ...fake, p };
}

module.exports = { fakeMoonraker, fakeOctoPrint, fakePrusaLink };

// `node test/fake-printers.js` runs all three on fixed ports for trying the setup screen.
if (require.main === module) {
  (async () => {
    await fakeMoonraker({ port: 7125 });
    await fakeOctoPrint({ apiKey: 'OCTOKEY', port: 5005 });
    await fakePrusaLink({ password: 'prusa', port: 8088 });
    console.log('Fake Moonraker on 127.0.0.1:7125, OctoPrint on :5005 (key OCTOKEY), PrusaLink on :8088 (maker / prusa)');
  })();
}
