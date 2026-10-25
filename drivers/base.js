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
  async startPrint() { throw new Error('starting prints not supported'); }

  // Returns { url, headers? } for the upstream camera stream, or null.
  cameraSource() { return null; }
  snapshotSource() { return null; }
  thumbSource() { return null; }
}

module.exports = { PrinterDriver };
