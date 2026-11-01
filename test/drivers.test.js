// Drivers against fake printer APIs: node --test
const test = require('node:test');
const assert = require('node:assert');
const { MoonrakerDriver } = require('../drivers/moonraker');
const { OctoPrintDriver } = require('../drivers/octoprint');
const { PrusaLinkDriver } = require('../drivers/prusalink');
const { baseUrl } = require('../drivers/base');
const { fakeMoonraker, fakeOctoPrint, fakePrusaLink } = require('./fake-printers');

// Resolves with the driver's state once `pred(state)` holds.
function waitFor(driver, pred, ms = 3000) {
  if (pred(driver.state)) return Promise.resolve(driver.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { driver.off('update', on); reject(new Error(`timed out; last state ${JSON.stringify(driver.state.status)} ${driver.state.error || ''}`)); }, ms);
    const on = (s) => { if (pred(s)) { clearTimeout(timer); driver.off('update', on); resolve(s); } };
    driver.on('update', on);
  });
}

async function withDriver(Driver, cfg, fake, fn) {
  const driver = new Driver({ id: 't', name: 'Test', host: fake.host, ...cfg }, { pollIntervalMs: 50 });
  try {
    await driver.start();
    await fn(driver);
  } finally {
    await driver.stop();
    fake.server.close();
  }
}

test('baseUrl accepts bare hosts, ports and full URLs', () => {
  assert.equal(baseUrl('192.168.1.5', 7125), 'http://192.168.1.5:7125');
  assert.equal(baseUrl('voron.local:80', 7125), 'http://voron.local:80');
  assert.equal(baseUrl('https://octo.lan/', 80), 'https://octo.lan');
  assert.equal(baseUrl('http://pi.local/octoprint/', 80), 'http://pi.local/octoprint');
  assert.throws(() => baseUrl('', 80), /No printer address/);
});

test('Moonraker: status, print lifecycle, control, light, files, camera', async () => {
  const fake = await fakeMoonraker({ apiKey: 'k1' });
  await withDriver(MoonrakerDriver, { apiKey: 'k1', lightPin: 'caselight' }, fake, async (d) => {
    let s = await waitFor(d, (x) => x.online);
    assert.equal(s.status, 'idle');
    assert.equal(s.firmware, 'v0.12.0');
    assert.deepEqual(s.temps.nozzle, { cur: 24, target: 0 });
    assert.equal(s.light, false);
    assert.equal(s.fans.part, 50);
    assert.equal(s.camera, 'mjpeg');
    assert.equal(d.cameraSource().url, `http://127.0.0.1/webcam/?action=stream`); // web UI port, not Moonraker's

    assert.deepEqual((await d.listFiles()).map((f) => f.name), ['cube.gcode', 'old/part.gcode']);
    await d.upload('new.gcode', Buffer.from('G28\n'));
    assert.ok(fake.p.files.some((f) => f.path === 'new.gcode'));
    await assert.rejects(d.upload('model.stl', Buffer.from('x')), /\.gcode/);

    await d.startPrint('cube.gcode');
    s = await waitFor(d, (x) => x.status === 'printing');
    assert.equal(s.job.file, 'cube.gcode');
    assert.equal(s.job.progress, 25);
    assert.equal(s.job.layer, 25);
    assert.equal(s.job.remaining, 3600 - 900); // slicer estimate minus elapsed
    assert.equal(s.speed.value, 125);
    assert.match(d.thumbSource().url, /\/server\/files\/gcodes\/\.thumbs\/cube-300x300\.png$/);

    await d.pause();
    await waitFor(d, (x) => x.status === 'paused');
    await d.resume();
    await waitFor(d, (x) => x.status === 'printing');
    await assert.rejects(d.control({ action: 'jog', axis: 'x', distance: 10 }), /during a print/);
    await d.control({ action: 'speed', value: 150 });
    await d.cancel();
    await waitFor(d, (x) => x.status === 'idle' && !x.job);

    await d.control({ action: 'jog', axis: 'z', distance: -1 });
    await d.control({ action: 'home', axes: 'xy' });
    await d.control({ action: 'temp', heater: 'bed', target: 60 });
    await d.control({ action: 'fan', pct: 100 });
    await d.setLight(true);
    await waitFor(d, (x) => x.light === true);
    assert.deepEqual(fake.p.gcode, ['M220 S150', 'G91\nG1 Z-1 F600\nG90', 'G28 X Y', 'M140 S60', 'M106 S255', 'SET_PIN PIN=caselight VALUE=1']);
  });
});

test('Moonraker: wrong API key reads as offline with a reason', async () => {
  const fake = await fakeMoonraker({ apiKey: 'right' });
  await withDriver(MoonrakerDriver, { apiKey: 'wrong' }, fake, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.equal(s.online, false);
  });
});

test('Moonraker: heating before the first layer reads as heating', async () => {
  const fake = await fakeMoonraker();
  Object.assign(fake.p, { state: 'printing', filename: 'cube.gcode', progress: 0, ext: { temperature: 120, target: 215 } });
  await withDriver(MoonrakerDriver, {}, fake, async (d) => {
    const s = await waitFor(d, (x) => x.online);
    assert.equal(s.status, 'heating');
    assert.equal(s.job.file, 'cube.gcode');
  });
});

test('OctoPrint: status, print lifecycle, files, control, camera', async () => {
  const fake = await fakeOctoPrint({ apiKey: 'KEY' });
  await withDriver(OctoPrintDriver, { apiKey: 'KEY' }, fake, async (d) => {
    let s = await waitFor(d, (x) => x.online);
    assert.equal(s.status, 'idle');
    assert.equal(s.firmware, 'OctoPrint 1.10.2');
    assert.equal(d.cameraSource().url, `http://${fake.host}/webcam/?action=stream`);
    assert.equal(d.snapshotSource().url, 'http://cam.local/snap');
    assert.deepEqual((await d.listFiles()).map((f) => f.name), ['parts/clip.gcode', 'benchy.gcode']);

    await d.upload('up.gcode', Buffer.from('G28'));
    assert.ok(fake.p.files.some((f) => f.path === 'up.gcode'));
    await d.startPrint('parts/clip.gcode');
    s = await waitFor(d, (x) => x.status === 'printing');
    assert.equal(s.job.file, 'parts/clip.gcode');
    assert.equal(s.job.progress, 12.5);
    assert.equal(s.job.remaining, 3000);

    await d.pause();
    await waitFor(d, (x) => x.status === 'paused');
    await d.resume();
    await waitFor(d, (x) => x.status === 'printing');
    await d.cancel();
    await waitFor(d, (x) => x.status === 'idle');

    await d.control({ action: 'jog', axis: 'y', distance: 5 });
    await d.control({ action: 'home', axes: 'xyz' });
    await d.control({ action: 'temp', heater: 'nozzle', target: 200 });
    await d.control({ action: 'motorsOff' });
    assert.deepEqual(fake.p.bodies.find((b) => b.path === '/api/printer/printhead').body, { command: 'jog', y: 5 });
    assert.deepEqual(fake.p.bodies.find((b) => b.path === '/api/printer/tool').body, { command: 'target', targets: { tool0: 200 } });
    assert.deepEqual(fake.p.commands, ['M18']);
  });
});

test('OctoPrint: printer not connected to OctoPrint, and a bad key', async () => {
  const fake = await fakeOctoPrint({ apiKey: 'KEY' });
  fake.p.connected = false;
  await withDriver(OctoPrintDriver, { apiKey: 'KEY' }, fake, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.match(s.error, /isn.t connected to the printer/);
  });
  const fake2 = await fakeOctoPrint({ apiKey: 'KEY' });
  await withDriver(OctoPrintDriver, { apiKey: 'nope' }, fake2, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.match(s.error, /refused the API key/);
  });
});

test('PrusaLink: digest auth, print lifecycle, files, upload', async () => {
  const fake = await fakePrusaLink({ password: 'secret' });
  await withDriver(PrusaLinkDriver, { password: 'secret' }, fake, async (d) => {
    let s = await waitFor(d, (x) => x.online);
    assert.equal(s.status, 'idle');
    assert.equal(s.model, 'MK4');
    assert.equal(s.firmware, '6.1.3');
    assert.equal(s.state?.capabilities?.control, undefined);
    assert.deepEqual((await d.listFiles()).map((f) => f.name), ['SHAPE~1.BGC']);

    await d.upload('part.bgcode', Buffer.from('x'.repeat(100)));
    assert.deepEqual(fake.p.uploads[0], { name: 'part.bgcode', size: 100, printAfter: '?0' });
    await d.startPrint('SHAPE~1.BGC');
    s = await waitFor(d, (x) => x.status === 'printing');
    assert.equal(s.job.progress, 30);
    assert.equal(s.job.remaining, 1200);
    assert.equal(s.job.thumb, true);
    assert.match(d.thumbSource().headers.Authorization, /^Digest /);

    await d.pause();
    await waitFor(d, (x) => x.status === 'paused');
    await d.resume();
    await waitFor(d, (x) => x.status === 'printing');
    await d.cancel();
    await waitFor(d, (x) => x.status === 'idle' && !x.job);
    // One challenge up front; afterwards the cached nonce is reused.
    assert.equal(fake.p.authFailures, 1);
  });
});

test('PrusaLink: wrong password is reported', async () => {
  const fake = await fakePrusaLink({ password: 'secret' });
  await withDriver(PrusaLinkDriver, { password: 'wrong' }, fake, async (d) => {
    const s = await waitFor(d, (x) => !!x.error);
    assert.match(s.error, /refused the password/);
  });
});

test('FlashForge: Clear sends setClearPlatform (needs the check code)', async () => {
  const { FlashForgeDriver } = require('../drivers/flashforge');
  const http = new FlashForgeDriver({ id: 'ff', host: '127.0.0.1', serialNumber: 'SN1', checkCode: 'abc' });
  const sent = [];
  http.post = async (path, body) => { sent.push({ path, body }); return { code: 0 }; };
  await http.clear();
  assert.deepEqual(sent, [{ path: '/control', body: { payload: { cmd: 'stateCtrl_cmd', args: { action: 'setClearPlatform' } } } }]);

  const tcp = new FlashForgeDriver({ id: 'ff2', host: '127.0.0.1' }); // no check code: the hub clears it on its own
  tcp.post = async () => { throw new Error('should not be called'); };
  await tcp.clear();
});
