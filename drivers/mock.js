// Simulated printer for trying the dashboard without hardware (npm run demo).
const { PrinterDriver } = require('./base');

const FILES = ['benchy.gcode', 'calibration_cube.gcode', 'phone_stand.3mf', 'cable_clip_x8.gcode'];

class MockDriver extends PrinterDriver {
  constructor(cfg, opts) {
    super(cfg, opts);
    this.state.capabilities = { pause: true, resume: true, cancel: true, light: true, files: true };
    this.sim = { status: 'idle', progress: 0, file: null, light: true, nozzle: 24, bed: 23 };
    if (cfg.startPrinting) Object.assign(this.sim, { status: 'printing', progress: 37, file: FILES[0], nozzle: 220, bed: 60 });
  }

  async start() {
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    this.tick();
  }

  async stop() { clearInterval(this.timer); }

  tick() {
    const s = this.sim;
    const hot = ['printing', 'paused', 'heating'].includes(s.status);
    const approach = (cur, target) => cur + (target - cur) * 0.15 + (Math.random() - 0.5) * 0.6;
    s.nozzle = approach(s.nozzle, hot ? 220 : 24);
    s.bed = approach(s.bed, hot ? 60 : 23);
    if (s.status === 'heating' && s.nozzle > 210) s.status = 'printing';
    if (s.status === 'printing') {
      s.progress = Math.min(100, s.progress + 0.4 * (this.cfg.speed || 1));
      if (s.progress >= 100) s.status = 'completed';
    }
    const total = 240;
    this.update({
      online: true,
      error: null,
      status: s.status,
      model: 'Simulator',
      firmware: 'mock-1.0',
      light: s.light,
      camera: 'mjpeg',
      temps: {
        nozzle: { cur: s.nozzle, target: hot ? 220 : 0 },
        bed: { cur: s.bed, target: hot ? 60 : 0 },
      },
      job: s.file && s.status !== 'idle' ? {
        file: s.file,
        progress: Math.round(s.progress * 10) / 10,
        layer: Math.round((s.progress / 100) * total),
        totalLayers: total,
        elapsed: Math.round(s.progress * 54),
        remaining: Math.round((100 - s.progress) * 54),
        thumb: false,
      } : null,
    });
  }

  async pause() { if (this.sim.status === 'printing') this.sim.status = 'paused'; this.tick(); }
  async resume() { if (this.sim.status === 'paused') this.sim.status = 'printing'; this.tick(); }
  async cancel() { Object.assign(this.sim, { status: 'idle', file: null, progress: 0 }); this.tick(); }
  async setLight(on) { this.sim.light = on; this.tick(); }
  async listFiles() { return FILES.map((name) => ({ name })); }
  async startPrint(file) { Object.assign(this.sim, { status: 'heating', file, progress: 0 }); this.tick(); }

  // Streams a moving SVG test pattern as multipart/x-mixed-replace, like an MJPEG camera.
  serveCamera(req, res) {
    const boundary = 'mockframe';
    res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`, 'Cache-Control': 'no-store' });
    let x = 0;
    const frame = () => {
      x = (x + 8) % 640;
      const s = this.sim;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#1d2127"/>
<rect x="120" y="250" width="400" height="18" rx="3" fill="#3a4150"/>
<rect x="${200 + Math.sin(x / 60) * 120}" y="150" width="60" height="40" rx="4" fill="#8b93a1"/>
<rect x="${226 + Math.sin(x / 60) * 120}" y="190" width="8" height="${Math.max(4, 58 - s.progress * 0.4)}" fill="#c9ced6"/>
<rect x="290" y="${250 - s.progress * 0.8}" width="60" height="${s.progress * 0.8}" fill="#e0883a"/>
<text x="16" y="28" fill="#c9ced6" font-family="monospace" font-size="14">${this.state.name} · simulated camera</text>
<text x="16" y="344" fill="#8b93a1" font-family="monospace" font-size="12">${new Date().toLocaleTimeString()}</text>
</svg>`;
      res.write(`--${boundary}\r\nContent-Type: image/svg+xml\r\nContent-Length: ${Buffer.byteLength(svg)}\r\n\r\n${svg}\r\n`);
    };
    frame();
    const t = setInterval(frame, 250);
    req.on('close', () => clearInterval(t));
  }
}

module.exports = { MockDriver };
