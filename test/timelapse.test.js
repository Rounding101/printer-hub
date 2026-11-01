// Timelapses recorded by the hub (lib/timelapse.js). The MP4 checks need
// FFmpeg (installed in CI and in the Docker image); without it the recording
// must fail with a clear message instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Timelapses } = require('../lib/timelapse');
const { MockDriver } = require('../drivers/mock');

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function videoSize(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
  return String(r.stdout).trim(); // "320x180" style -> "320,180"
}

async function settle(tl, pred, ms = 30000) {
  for (let t = 0; t < ms; t += 100) { if (pred()) return; await sleep(100); }
  throw new Error(`timed out: ${JSON.stringify(tl.list())}`);
}

test('records a frame per layer plus a final one, cropped like the camera', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir);
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    driver.cfg.cameraCrop = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const state = (status, layer) => ({ id: 'm', name: 'Mock', camera: 'mjpeg', status, job: { file: 'part.gcode', layer, totalLayers: 12 } });
    for (let layer = 1; layer <= 12; layer++) {
      driver.sim.progress = (layer / 12) * 100;
      tl.observe(driver, state('printing', layer));
      tl.observe(driver, state('printing', layer)); // same layer again: no extra frame
      await sleep(5);
    }
    tl.observe(driver, state('completed', 12));
    await settle(tl, () => ['ready', 'failed'].includes(tl.list()[0]?.status));
    const item = tl.list()[0];
    assert.equal(item.frames, 13);
    assert.equal(item.outcome, 'completed');
    if (HAS_FFMPEG) {
      assert.equal(item.status, 'ready', item.error);
      assert.ok(fs.statSync(tl.videoPath(item)).size > 1000);
      assert.ok(fs.existsSync(tl.posterPath(item)), 'poster frame');
      assert.equal(videoSize(tl.videoPath(item)), '320,180', 'cropped to the middle quarter');
      assert.ok(!fs.existsSync(tl.framesDir(item)), 'frames cleaned up');
    } else {
      assert.equal(item.status, 'failed');
      assert.match(item.error, /FFmpeg isn.t installed/);
    }
    tl.remove(item.id);
    assert.equal(tl.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing is recorded without a camera, or with timelapses off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir);
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    tl.observe(driver, { id: 'm', name: 'Mock', camera: null, status: 'printing', job: { file: 'a.gcode', layer: 1, totalLayers: 5 } });
    driver.cfg.timelapse = false;
    tl.observe(driver, { id: 'm', name: 'Mock', camera: 'mjpeg', status: 'printing', job: { file: 'a.gcode', layer: 1, totalLayers: 5 } });
    assert.equal(tl.list().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('printers that report no layers get a frame every interval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir, { intervalMs: 50, graceMs: 0 });
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    const s = { id: 'm', name: 'Mock', camera: 'mjpeg', status: 'printing', job: { file: 'b.gcode', layer: 0, totalLayers: 0 } };
    for (let i = 0; i < 6; i++) { tl.observe(driver, s); await sleep(60); }
    tl.observe(driver, { ...s, status: 'idle', job: null }); // cancelled
    await settle(tl, () => ['ready', 'failed'].includes(tl.list()[0]?.status));
    assert.equal(tl.list()[0].frames, 6);
    assert.equal(tl.list()[0].outcome, 'stopped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the hub records a simulated print and serves the video with Range', { skip: !HAS_FFMPEG && 'needs FFmpeg' }, async () => {
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-hub-'));
  const configPath = path.join(dir, 'config.json');
  // A fast simulator: done in a few polls.
  fs.writeFileSync(configPath, JSON.stringify({ pollIntervalMs: 150, printers: [{ id: 'sim', name: 'Sim', type: 'mock', startPrinting: true, speed: 30 }] }));
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--config', configPath], {
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SLICER_URL: '' },
  });
  let log = '';
  try {
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(log)), 10000);
      child.stdout.on('data', (d) => { log += d; const m = /setup code (\S+)/.exec(log); if (m) { clearTimeout(t); resolve(m[1]); } });
    });
    const base = `http://127.0.0.1:${port}`;
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ code, username: 'admin', password: 'admin-password-1' }) });
    const cookie = setup.headers.get('set-cookie').split(';')[0];
    const get = (p, h = {}) => fetch(base + p, { headers: { Cookie: cookie, ...h } });
    let item;
    for (let i = 0; i < 200 && item?.status !== 'ready'; i++) {
      await sleep(150);
      item = (await (await get('/api/timelapses')).json())[0];
      assert.notEqual(item?.status, 'failed', item?.error);
    }
    assert.equal(item.status, 'ready');
    assert.equal(item.outcome, 'completed');
    assert.ok(item.frames >= 3);
    const whole = await get(`/api/timelapses/${item.id}/video`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    const part = await get(`/api/timelapses/${item.id}/video`, { Range: 'bytes=0-99' });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    assert.equal((await get(`/api/timelapses/${item.id}/poster`)).headers.get('content-type'), 'image/jpeg');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a blip mid-print does not end the recording', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  try {
    const tl = new Timelapses(dir); // default one-minute grace
    const driver = new MockDriver({ id: 'm', name: 'Mock' }, {});
    const s = (status, layer) => ({ id: 'm', name: 'Mock', camera: 'mjpeg', status, job: status === 'printing' ? { file: 'c.gcode', layer, totalLayers: 9 } : null });
    tl.observe(driver, s('printing', 1));
    tl.observe(driver, s('error'));
    tl.observe(driver, s('printing', 2));
    assert.equal(tl.list().length, 1);
    assert.equal(tl.list()[0].status, 'recording');
    assert.equal(tl.active.get('m').stoppedAt, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
