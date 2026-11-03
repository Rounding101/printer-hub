// Elegoo Centauri Carbon 2 driver against a fake printer: node --test
// The fake stands in for the MQTT client (the printer is the broker) and serves
// the printer's HTTP endpoints (/system/info, /upload).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ElegooDriver, mapStatus } = require('../drivers/elegoo');

const SN = 'CC2SN0001';

function idleStatus() {
  return {
    extruder: { target: 0, temperature: 33 },
    heater_bed: { target: 0, temperature: 30 },
    fans: { fan: { speed: 127.5 }, aux_fan: { speed: 0 }, box_fan: { speed: 255 } },
    gcode_move: { speed_mode: 1 },
    led: { status: 1 },
    machine_status: { exception_status: [], progress: 0, status: 1, sub_status: 0 },
    print_status: { current_layer: 0, filename: '', print_duration: 0, remaining_time_sec: 0, state: '' },
    ztemperature_sensor: { temperature: 27 },
  };
}

async function fakeCentauri({ code = '123456', clientLimit = false } = {}) {
  const p = { status: idleStatus(), requests: [], uploads: [], seq: 100, clients: [] };
  const files = [
    { filename: 'old.gcode', size: 10, create_time: 1, layer: 50 },
    { filename: 'cube.gcode', size: 20, create_time: 2, layer: 120 },
  ];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/system/info') {
      if (url.searchParams.get('X-Token') !== code) { res.writeHead(401); return res.end(); }
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error_code: 0, system_info: { sn: SN } }));
    }
    if (url.pathname === '/upload' && req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        p.uploads.push({ range: req.headers['content-range'], name: req.headers['x-file-name'], md5: req.headers['x-file-md5'], token: req.headers['x-token'], size: Buffer.concat(chunks).length });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error_code: 0 }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // Pushes a status delta to every registered client.
  p.push = (delta) => {
    for (const c of p.clients) c.deliver(`elegoo/${SN}/api_status`, { id: p.seq++, method: 6000, result: delta });
  };

  const results = {
    // Shape as reported by a real CC2 on firmware 02.01.01.07.
    1001: () => ({ error_code: 0, machine_model: 'Centauri Carbon 2', software_version: { mcu_version: '00.00.00.00', ota_version: '02.01.01.07', soc_version: '' }, sn: SN }),
    1002: () => ({ error_code: 0, ...JSON.parse(JSON.stringify(p.status)) }),
    1020: (params) => {
      Object.assign(p.status.machine_status, { status: 2, sub_status: 2075, progress: 10 });
      Object.assign(p.status.print_status, { filename: params.filename, current_layer: 12, print_duration: 600, remaining_time_sec: 3000, state: 'printing' });
      return { error_code: 0 };
    },
    1021: () => { p.status.machine_status.sub_status = 2502; return { error_code: 0 }; },
    1023: () => { p.status.machine_status.sub_status = 2075; return { error_code: 0 }; },
    1022: () => { Object.assign(p.status.machine_status, { status: 1, sub_status: 0 }); p.status.print_status.filename = ''; return { error_code: 0 }; },
    1026: () => ({ error_code: 0 }),
    1027: () => ({ error_code: 0 }),
    1028: () => ({ error_code: 0 }),
    1029: (params) => { p.status.led.status = params.power; return { error_code: 0 }; },
    1030: () => ({ error_code: 0 }),
    1031: () => (p.status.machine_status.status === 2 ? { error_code: 0 } : { error_code: 1010 }),
    1044: (params) => ({ error_code: 0, file_list: files.slice(params.offset, params.offset + params.limit), offset: params.offset, total: files.length }),
    1046: (params) => ({ error_code: 0, filename: params.filename, total_layer: files.find((f) => f.filename === params.filename)?.layer || 0 }),
    2005: () => ({ error_code: 0, canvas_info: { canvas_list: [{ canvas_id: 0, tray_list: [
      { tray_id: 0, filament_color: '#FF0000', filament_type: 'PLA', status: 1 },
      { tray_id: 1, filament_color: '#00FF00', filament_type: 'PETG', status: 0 },
    ] }] } }),
  };

  function connect(opts) {
    const client = new EventEmitter();
    client.connected = false;
    client.opts = opts;
    client.subs = [];
    client.deliver = (topic, body) => {
      const match = client.subs.some((s) => new RegExp(`^${s.replace(/\+/g, '[^/]+').replace(/#$/, '.*')}$`).test(topic));
      if (match && client.connected) setImmediate(() => client.emit('message', topic, Buffer.from(JSON.stringify(body))));
    };
    client.subscribe = (t) => { client.subs.push(...[].concat(t)); };
    client.unsubscribe = (t) => { client.subs = client.subs.filter((s) => s !== t); };
    client.end = () => { client.connected = false; p.clients = p.clients.filter((c) => c !== client); };
    client.publish = (topic, payload) => {
      const msg = JSON.parse(payload);
      if (topic === `elegoo/${SN}/api_register`) {
        const full = clientLimit && p.clients.length >= 2;
        if (!full) p.clients.push(client);
        return client.deliver(`elegoo/${SN}/${msg.request_id}/register_response`, full ? { client_id: msg.client_id, error: 'too many clients', code: 3 } : { client_id: msg.client_id, error: 'ok' });
      }
      const m = /^elegoo\/[^/]+\/([^/]+)\/api_request$/.exec(topic);
      if (!m) return;
      if (msg.type === 'PING') return client.deliver(`elegoo/${SN}/${m[1]}/api_response`, { type: 'PONG' });
      p.requests.push({ method: msg.method, params: msg.params });
      const result = results[msg.method] ? results[msg.method](msg.params || {}) : { error_code: 1001 };
      client.deliver(`elegoo/${SN}/${m[1]}/api_response`, { id: msg.id, method: msg.method, result });
    };
    setImmediate(() => {
      if (opts.username !== 'elegoo' || opts.password !== code) return client.emit('error', new Error('Connection refused: Not authorized'));
      client.connected = true;
      client.emit('connect');
    });
    return client;
  }

  return { p, connect, host: `127.0.0.1:${server.address().port}`, server };
}

function waitFor(driver, pred, ms = 3000) {
  if (pred(driver.state)) return Promise.resolve(driver.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { driver.off('update', on); reject(new Error(`timed out; last state ${driver.state.status} ${driver.state.error || ''}`)); }, ms);
    const on = (s) => { if (pred(s)) { clearTimeout(timer); driver.off('update', on); resolve(s); } };
    driver.on('update', on);
  });
}

async function withDriver(fake, cfg, fn) {
  const d = new ElegooDriver({ id: 'cc2', name: 'CC2', type: 'elegoo', host: fake.host, ...cfg }, { connect: fake.connect, gapMs: 0, pingMs: 60000 });
  try {
    await d.start();
    await fn(d);
  } finally {
    await d.stop();
    fake.server.close();
  }
}

test('Elegoo CC2: connects, reports status, files, prints, controls, uploads', async () => {
  const fake = await fakeCentauri({ code: 'ABC123' });
  await withDriver(fake, { accessCode: 'ABC123' }, async (d) => {
    let s = await waitFor(d, (x) => x.online && x.firmware);
    assert.equal(s.status, 'idle');
    assert.equal(s.model, 'Centauri Carbon 2');
    assert.equal(s.firmware, '02.01.01.07');
    assert.deepEqual(s.temps.nozzle, { cur: 33, target: 0 });
    assert.deepEqual(s.temps.chamber, { cur: 27, target: 0 });
    assert.equal(s.fans.part, 50);
    assert.equal(s.fans.chamber, 100);
    assert.equal(s.light, true);
    assert.equal(s.camera, 'mjpeg');
    assert.equal(d.cameraSource().url, 'http://127.0.0.1:8080/?action=stream');
    s = await waitFor(d, (x) => x.slots);
    assert.deepEqual(s.slots, [{ index: 0, color: [255, 0, 0], type: 'PLA', ready: true }, { index: 1, color: [0, 255, 0], type: 'PETG', ready: false }]);

    // Deltas merge into the snapshot.
    fake.p.push({ extruder: { target: 220, temperature: 150 } });
    s = await waitFor(d, (x) => x.temps.nozzle.target === 220);
    assert.equal(s.temps.bed.cur, 30); // untouched by the delta

    assert.deepEqual((await d.listFiles()).map((f) => f.name), ['cube.gcode', 'old.gcode']);

    await d.startPrint('cube.gcode');
    assert.deepEqual(fake.p.requests.find((r) => r.method === 1020).params, { storage_media: 'local', filename: 'cube.gcode', config: { printer_check: true, slot_map: [] } });
    fake.p.push(JSON.parse(JSON.stringify({ machine_status: fake.p.status.machine_status, print_status: fake.p.status.print_status })));
    s = await waitFor(d, (x) => x.status === 'printing');
    assert.equal(s.job.file, 'cube.gcode');
    assert.equal(s.job.progress, 10);
    assert.equal(s.job.layer, 12);
    assert.equal(s.job.totalLayers, 120); // from the file list
    assert.equal(s.job.remaining, 3000);
    assert.equal(s.speed.kind, 'mode');

    await d.control({ action: 'speed', value: 2 });
    assert.equal(d.state.speed.value, 2);
    await assert.rejects(d.control({ action: 'jog', axis: 'x', distance: 10 }), /during a print/);

    await d.pause();
    fake.p.push({ machine_status: { sub_status: 2502 } });
    await waitFor(d, (x) => x.status === 'paused');
    await d.resume();
    fake.p.push({ machine_status: { sub_status: 2075 } });
    await waitFor(d, (x) => x.status === 'printing');
    await d.cancel();
    fake.p.push({ machine_status: { status: 1, sub_status: 0 }, print_status: { filename: '' } });
    s = await waitFor(d, (x) => x.status === 'idle' && !x.job);
    assert.equal(s.speed, null);

    await d.control({ action: 'jog', axis: 'z', distance: -1 });
    await d.control({ action: 'home', axes: 'xyz' });
    await d.control({ action: 'temp', heater: 'bed', target: 60 });
    await d.control({ action: 'fan', pct: 100 });
    await d.setLight(false);
    assert.equal(d.state.light, false);
    const sent = (m) => fake.p.requests.filter((r) => r.method === m).map((r) => r.params);
    assert.deepEqual(sent(1027), [{ axes: 'z', distance: -1 }]);
    assert.deepEqual(sent(1026), [{ homed_axes: 'xyz' }]);
    assert.deepEqual(sent(1028), [{ heater_bed: 60 }]);
    assert.deepEqual(sent(1030), [{ fan: 255 }]);
    assert.deepEqual(sent(1029), [{ power: 0 }]);

    // 2.5 MiB goes up in three ranged chunks, each with the whole-file MD5.
    const data = crypto.randomBytes(2.5 * 1024 * 1024);
    await d.upload('part.gcode', data);
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    assert.deepEqual(fake.p.uploads.map((u) => u.range), ['bytes 0-1048575/2621440', 'bytes 1048576-2097151/2621440', 'bytes 2097152-2621439/2621440']);
    assert.ok(fake.p.uploads.every((u) => u.md5 === md5 && u.name === 'part.gcode' && u.token === 'ABC123'));
    await assert.rejects(d.upload('model.3mf', data), /\.gcode/);
  });
});

test('Elegoo CC2: a wrong access code is reported', async () => {
  const fake = await fakeCentauri({ code: 'right' });
  await withDriver(fake, { accessCode: 'wrong' }, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.equal(s.online, false);
    assert.match(s.error, /access code/);
  });
});

test('Elegoo CC2: a full client list is explained', async () => {
  const fake = await fakeCentauri({ clientLimit: true });
  fake.p.clients.push({ deliver() {} }, { deliver() {} }); // the Elegoo app and slicer
  await withDriver(fake, {}, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.match(s.error, /two LAN connections/);
  });
});

test('Elegoo CC2: status codes map to hub statuses', () => {
  const st = (machine_status, print_status = {}) => mapStatus({ machine_status, print_status }).status;
  assert.equal(st({ status: 1 }), 'idle');
  assert.equal(st({ status: 2, sub_status: 2075 }), 'printing');
  assert.equal(st({ status: 2, sub_status: 1045 }), 'heating');
  assert.equal(st({ status: 2, sub_status: 2501 }), 'pausing');
  assert.equal(st({ status: 2, sub_status: 2505 }), 'paused'); // filament runout
  assert.equal(st({ status: 2, sub_status: 2503 }), 'cancelling');
  assert.equal(st({ status: 1, sub_status: 2077 }), 'completed');
  assert.equal(st({ status: 1 }, { state: 'complete' }), 'completed');
  assert.equal(st({ status: 10 }), 'busy');
  assert.equal(st({ status: 14 }), 'error');
  assert.deepEqual(mapStatus({ machine_status: { status: 2, exception_status: [103] } }), { status: 'error', error: 'Nozzle heating failed' });
  assert.equal(st({ status: 2, exception_status: [1301] }), 'printing'); // warnings don't stop the print
});
