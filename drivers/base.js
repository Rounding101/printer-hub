const { EventEmitter } = require('node:events');

// Normalized status values shared by every driver:
// offline | idle | heating | printing | pausing | paused | cancelling | completed | busy | error
class PrinterDriver extends EventEmitter {
  constructor(cfg, opts = {}) {
    super();
    this.cfg = cfg;
    this.pollIntervalMs = opts.pollIntervalMs || 3000;
    this.state = {
      id: cfg.id,
      name: cfg.name || cfg.id,
      type: cfg.type,
      host: cfg.host || null,
      online: false,
      status: 'offline',
      error: null,
      model: null,
      firmware: null,
      job: null, // { file, progress (0-100), layer, totalLayers, elapsed (s), remaining (s), thumb (bool) }
      temps: {}, // { nozzle: {cur, target}, bed: {cur, target}, chamber: {cur, target} }
      light: null, // true | false | null when unsupported
      camera: null, // 'mjpeg' | 'flv' | null
      fans: {}, // { part: pct, aux: pct, chamber: pct } as reported
      speed: null, // { kind: 'percent'|'mode', value, options? } during prints
      slots: null, // multi-color unit: [{ index, color:[r,g,b], type, ready }]
      capabilities: { pause: true, resume: true, cancel: true, light: false, files: true },
      updatedAt: null,
    };
  }

  update(patch) {
    Object.assign(this.state, patch, { updatedAt: Date.now() });
    this.emit('update', this.state);
  }

  setOffline(err) {
    this.update({ online: false, status: 'offline', error: err ? String(err.message || err) : null });
  }

  async start() {}
  async stop() {}

  // Commands; drivers override what they support.
  async pause() { throw new Error('pause not supported'); }
  async resume() { throw new Error('resume not supported'); }
  async cancel() { throw new Error('cancel not supported'); }
  async setLight() { throw new Error('light control not supported'); }
  async listFiles() { return []; }
  // { colors: [{index, color, material, slot}], slots: [{index, color, type, ready}], options: [{key, label, default}] }
  async printOptions() { return { colors: [], slots: [], options: [] }; }
  async startPrint() { throw new Error('starting prints not supported'); }
  async upload() { throw new Error('uploading files not supported'); }

  // Manual control. `cmd` is one of:
  //   { action: 'jog', axis: 'x'|'y'|'z', distance }   (mm, relative)
  //   { action: 'home', axes: 'xyz'|'xy'|'z' }
  //   { action: 'temp', heater: 'nozzle'|'bed', target }
  //   { action: 'fan', fan: 'part', pct }
  //   { action: 'speed', value }                        (driver-specific scale)
  //   { action: 'motorsOff' }
  // validateControl() enforces the shared safety rules before a driver runs it.
  async control() { throw new Error('manual control not supported'); }

  validateControl(cmd) {
    const limits = this.limits || { nozzle: 300, bed: 110, jog: 100 };
    const busy = ['printing', 'pausing', 'paused', 'heating', 'cancelling', 'busy'].includes(this.state.status);
    if (!this.state.online) throw new Error('Printer is offline');
    switch (cmd.action) {
      case 'jog': {
        if (busy) throw new Error('Can’t move the axes during a print');
        if (!['x', 'y', 'z'].includes(cmd.axis)) throw new Error('axis must be x, y or z');
        const d = Number(cmd.distance);
        if (!Number.isFinite(d) || d === 0 || Math.abs(d) > limits.jog) throw new Error(`distance must be ±0.1–${limits.jog} mm`);
        return { ...cmd, distance: Math.round(d * 10) / 10 };
      }
      case 'home':
        if (busy) throw new Error('Can’t home during a print');
        if (!['xyz', 'xy', 'z'].includes(cmd.axes)) throw new Error('axes must be xyz, xy or z');
        return cmd;
      case 'motorsOff':
        if (busy) throw new Error('Can’t disable motors during a print');
        return cmd;
      case 'temp': {
        if (!['nozzle', 'bed'].includes(cmd.heater)) throw new Error('heater must be nozzle or bed');
        const t = Math.round(Number(cmd.target));
        const max = limits[cmd.heater];
        if (!Number.isFinite(t) || t < 0 || t > max) throw new Error(`${cmd.heater} target must be 0–${max} °C`);
        return { ...cmd, target: t };
      }
      case 'fan': {
        const p = Math.round(Number(cmd.pct));
        if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error('fan must be 0–100%');
        return { ...cmd, fan: cmd.fan || 'part', pct: p };
      }
      case 'speed':
        if (!['printing', 'paused', 'pausing'].includes(this.state.status)) throw new Error('Speed can only be changed during a print');
        return cmd;
      default:
        throw new Error(`Unknown control action: ${cmd.action}`);
    }
  }

  // Returns { url, headers? } for the upstream camera stream, or null.
  cameraSource() { return null; }
  snapshotSource() { return null; }
  thumbSource() { return null; }
}

module.exports = { PrinterDriver };
