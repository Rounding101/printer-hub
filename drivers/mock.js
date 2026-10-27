// Simulated printer for trying the dashboard without hardware (npm run demo).
const { PrinterDriver } = require('./base');

const FILES = ['benchy.gcode', 'calibration_cube.gcode', 'phone_stand.3mf', 'cable_clip_x8.gcode'];

class MockDriver extends PrinterDriver {
  constructor(cfg, opts) {
    super(cfg, opts);
    this.limits = { nozzle: 300, bed: 110, jog: 100 };
    this.state.capabilities = {
      pause: true, resume: true, cancel: true, light: true, files: true,
      control: { jog: true, home: true, motorsOff: true, temps: ['nozzle', 'bed'], fans: ['part'], speed: cfg.multiColor ? 'mode' : 'percent', limits: this.limits },
    };
    this.manual = { nozzle: 0, bed: 0, fan: 0, speed: cfg.multiColor ? 2 : 100, pos: { x: 110, y: 110, z: 10 } };
    this.files = [...FILES];
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
    const nozzleTarget = hot ? 220 : this.manual.nozzle;
    const bedTarget = hot ? 60 : this.manual.bed;
    s.nozzle = approach(s.nozzle, nozzleTarget || 24);
    s.bed = approach(s.bed, bedTarget || 23);
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
        nozzle: { cur: s.nozzle, target: nozzleTarget },
        bed: { cur: s.bed, target: bedTarget },
      },
      fans: { part: hot ? Math.max(this.manual.fan, 100) : this.manual.fan },
      speed: ['printing', 'paused'].includes(s.status)
        ? (this.cfg.multiColor
          ? { kind: 'mode', value: this.manual.speed, options: [{ value: 1, label: 'Silent' }, { value: 2, label: 'Standard' }, { value: 3, label: 'Sport' }] }
          : { kind: 'percent', value: this.manual.speed, min: 50, max: 150 })
        : null,
      slots: this.cfg.multiColor ? [
        { index: 0, color: [241, 240, 237], type: 'PLA High Speed', ready: true, percent: 100 },
        { index: 1, color: [239, 96, 163], type: 'PLA Matte', ready: true, percent: 72 },
        { index: 2, color: [255, 194, 244], type: 'PLA Matte', ready: false, percent: null },
        { index: 3, color: [158, 166, 180], type: 'PLA+', ready: true, percent: 35 },
      ] : null,
      job: s.file && s.status !== 'idle' ? {
        file: s.file,
        progress: Math.round(s.progress * 10) / 10,
        layer: Math.round((s.progress / 100) * total),
        totalLayers: total,
        elapsed: Math.round(s.progress * 54),
        remaining: Math.round((100 - s.progress) * 54),
        grams: 20, // like the AD5M's own job filament estimate
        thumb: false,
      } : null,
    });
  }

  async pause() { if (this.sim.status === 'printing') this.sim.status = 'paused'; this.tick(); }
  async resume() { if (this.sim.status === 'paused') this.sim.status = 'printing'; this.tick(); }
  async cancel() { Object.assign(this.sim, { status: 'idle', file: null, progress: 0 }); this.tick(); }
  async setLight(on) { this.sim.light = on; this.tick(); }
  async listFiles() { return this.files.map((name) => ({ name })); }
  async printOptions(file) {
    if (!this.cfg.multiColor) return { colors: [], slots: [], options: [{ key: 'autoLevel', label: 'Auto-level before printing', default: false }] };
    const slots = [
      { index: 0, color: [241, 240, 237], type: 'PLA High Speed', ready: true },
      { index: 1, color: [239, 96, 163], type: 'PLA Matte', ready: true },
      { index: 2, color: [255, 194, 244], type: 'PLA Matte', ready: false },
      { index: 3, color: [158, 166, 180], type: 'PLA+', ready: true },
    ];
    const colors = /benchy/.test(file)
      ? [{ index: 0, color: [230, 90, 160], material: 'PLA', grams: 12, slot: 1 }, { index: 1, color: [250, 250, 250], material: 'PLA', grams: 3, slot: 0 }]
      : [{ index: 0, color: [254, 209, 65], material: 'PLA', grams: 8, slot: 0 }];
    return { colors, slots, options: [{ key: 'autoLevel', label: 'Auto-level before printing', default: true }] };
  }
  async startPrint(file, opts = {}) {
    this.lastStart = { file, ...opts };
    Object.assign(this.sim, { status: 'heating', file, progress: 0 });
    this.tick();
  }
  async control(raw) {
    const cmd = this.validateControl(raw);
    const m = this.manual;
    if (cmd.action === 'jog') m.pos[cmd.axis] = Math.round((m.pos[cmd.axis] + cmd.distance) * 10) / 10;
    if (cmd.action === 'home') for (const a of cmd.axes) m.pos[a] = 0;
    if (cmd.action === 'temp') m[cmd.heater] = cmd.target;
    if (cmd.action === 'fan') m.fan = cmd.pct;
    if (cmd.action === 'speed') m.speed = Number(cmd.value);
    this.lastControl = cmd;
    this.tick();
  }

  async upload(name, data) {
    if (!data.length) throw new Error('Empty file');
    if (!this.files.includes(name)) this.files.unshift(name);
  }

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
