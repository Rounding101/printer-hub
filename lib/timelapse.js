// Timelapses recorded by the hub: a camera frame per layer while a printer
// prints (or every few seconds if it doesn't report layers), turned into an
// MP4 with FFmpeg when the print ends, cropped like the printer's camera.
// Works for any printer with a camera. Stored in data/timelapses/.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const INTERVAL_MS = 20000;  // between frames when the printer doesn't report layers
const MAX_FRAMES = 3000;
const PRINTING = new Set(['printing']);
const KEEP_GOING = new Set(['printing', 'paused', 'pausing', 'heating', 'preparing', 'busy']); // still the same print

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' };

// GET an image with a timeout; resolves { data, type }.
function fetchImage(source, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = source.url.startsWith('https') ? https : http;
    const req = lib.get(source.url, { headers: source.headers || {}, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (res.statusCode !== 200 || !EXT[type]) { res.resume(); reject(new Error(`no image (${res.statusCode} ${type})`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { chunks.push(c); size += c.length; if (size > 20e6) req.destroy(new Error('image too large')); });
      res.on('end', () => resolve({ data: Buffer.concat(chunks), type }));
    });
    req.on('timeout', () => req.destroy(new Error('camera timeout')));
    req.on('error', reject);
  });
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('FFmpeg isn’t installed') : e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`));
    });
  });
}

class Timelapses extends EventEmitter {
  constructor(dataDir, { ffmpeg = process.env.FFMPEG || 'ffmpeg', intervalMs = INTERVAL_MS } = {}) {
    super();
    this.dir = path.join(dataDir, 'timelapses');
    this.indexFile = path.join(this.dir, 'index.json');
    this.ffmpeg = ffmpeg;
    this.intervalMs = intervalMs;
    fs.mkdirSync(this.dir, { recursive: true });
    this.items = fs.existsSync(this.indexFile) ? JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) : [];
    this.active = new Map(); // printer id -> item being recorded
    // Recordings cut short by a restart: encode what was captured.
    for (const item of this.items.filter((i) => i.status === 'recording' || i.status === 'encoding')) {
      item.status = 'recording';
      item.outcome = item.outcome || 'unknown';
      this.encode(item);
    }
  }

  save() {
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1));
    fs.renameSync(tmp, this.indexFile);
    this.emit('change', this.list());
  }

  list() { return [...this.items].sort((a, b) => b.startedAt - a.startedAt); }
  get(id) { const i = this.items.find((x) => x.id === id); if (!i) throw new Error('Unknown timelapse'); return i; }
  framesDir(item) { return path.join(this.dir, item.id); }
  videoPath(item) { return path.join(this.dir, `${item.id}.mp4`); }
  posterPath(item) { return path.join(this.dir, `${item.id}.jpg`); }

  remove(id) {
    const item = this.get(id);
    if (item.status === 'recording') throw new Error('Still recording; it can be deleted when the print ends');
    for (const p of [this.framesDir(item), this.videoPath(item), this.posterPath(item)]) fs.rmSync(p, { recursive: true, force: true });
    this.items = this.items.filter((i) => i !== item);
    this.save();
  }

  // Called with every printer update.
  observe(driver, state) {
    const rec = this.active.get(state.id);
    const job = state.job;
    if (rec && (!KEEP_GOING.has(state.status) || (job?.file && job.file !== rec.file))) {
      this.finish(driver, rec, state.status === 'completed' ? 'completed' : state.status === 'idle' ? 'stopped' : state.status);
    }
    if (!PRINTING.has(state.status) || !job?.file || !state.camera || driver.cfg.timelapse === false) return;
    let item = this.active.get(state.id);
    if (!item) {
      item = {
        id: crypto.randomUUID(), printerId: state.id, printerName: state.name, file: job.file,
        startedAt: Date.now(), endedAt: null, frames: 0, ext: null, status: 'recording', outcome: null,
        lastLayer: null, lastAt: 0,
      };
      fs.mkdirSync(this.framesDir(item), { recursive: true });
      this.items.push(item);
      this.active.set(state.id, item);
      this.save();
    }
    const byLayer = job.totalLayers > 0 && job.layer > 0;
    const due = byLayer ? job.layer !== item.lastLayer : Date.now() - item.lastAt >= this.intervalMs;
    if (due) {
      item.lastLayer = job.layer;
      item.lastAt = Date.now();
      this.capture(driver, item);
    }
  }

  async frame(driver) {
    if (driver.captureFrame) return driver.captureFrame();
    const snap = driver.snapshotSource?.();
    if (snap) { try { return await fetchImage(snap); } catch { /* fall back to the stream */ } }
    const cam = driver.cameraSource?.();
    if (!cam) throw new Error('No camera');
    // One frame from the live stream (MJPEG, FLV, RTSP…).
    const headers = Object.entries(cam.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    const data = await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '10000000',
      ...(headers ? ['-headers', headers] : []), '-i', cam.url, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], 20000);
    return { data, type: 'image/jpeg' };
  }

  async capture(driver, item) {
    if (item.busy || item.frames >= MAX_FRAMES) return;
    item.busy = true;
    try {
      const { data, type } = await this.frame(driver);
      const ext = EXT[type];
      if (!item.ext) item.ext = ext;
      if (ext !== item.ext) return; // keep one format per recording
      item.frames += 1;
      fs.writeFileSync(path.join(this.framesDir(item), `${String(item.frames).padStart(5, '0')}.${ext}`), data);
      item.error = null;
      if (item.frames % 5 === 1) this.save(); // live frame count on the Timelapses page
    } catch (err) {
      item.error = err.message;
    } finally {
      item.busy = false;
    }
  }

  async finish(driver, item, outcome) {
    this.active.delete(item.printerId);
    if (outcome === 'completed') { while (item.busy) await new Promise((r) => setTimeout(r, 200)); await this.capture(driver, item); }
    item.outcome = outcome;
    item.endedAt = Date.now();
    item.crop = driver.cfg.cameraCrop || null;
    await this.encode(item);
  }

  async encode(item) {
    while (item.busy) await new Promise((r) => setTimeout(r, 200));
    delete item.lastLayer; delete item.lastAt; delete item.busy;
    if (item.frames < 2) { // nothing worth keeping
      fs.rmSync(this.framesDir(item), { recursive: true, force: true });
      this.items = this.items.filter((i) => i !== item);
      this.save();
      return;
    }
    item.status = 'encoding';
    this.save();
    // ~10 seconds of video, 10–30 frames per second; the last frame held for a second.
    const fps = Math.max(10, Math.min(30, Math.round(item.frames / 10)));
    const c = item.crop;
    const filters = [
      ...(c ? [`crop=trunc(iw*${c.w}/2)*2:trunc(ih*${c.h}/2)*2:trunc(iw*${c.x}):trunc(ih*${c.y})`] : []),
      'scale=trunc(iw/2)*2:trunc(ih/2)*2', `tpad=stop_mode=clone:stop_duration=1`,
    ].join(',');
    try {
      await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps),
        '-i', path.join(this.framesDir(item), `%05d.${item.ext}`), '-vf', filters,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        this.videoPath(item)], 15 * 60 * 1000);
      await run(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-0.5', '-i', this.videoPath(item),
        '-frames:v', '1', '-q:v', '4', this.posterPath(item)], 60000).catch(() => {});
      item.status = 'ready';
      item.size = fs.statSync(this.videoPath(item)).size;
      item.seconds = Math.round((item.frames / fps + 1) * 10) / 10;
      item.error = null;
      fs.rmSync(this.framesDir(item), { recursive: true, force: true });
    } catch (err) {
      item.status = 'failed';
      item.error = err.message;
    }
    this.save();
  }
}

module.exports = { Timelapses, fetchImage };
