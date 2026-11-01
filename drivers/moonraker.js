// Klipper printers through Moonraker's HTTP API (Voron, Creality K1 / Sonic
// Pad, Elegoo Neptune 4, Sovol, Qidi, RatRig and other Klipper machines).
// Docs: https://moonraker.readthedocs.io/en/latest/web_api/
const { PrinterDriver, baseUrl, HOST_FIELD, CAMERA_FIELD } = require('./base');
const { postMultipart } = require('../lib/multipart');

const OBJECTS = ['webhooks', 'print_stats', 'virtual_sdcard', 'display_status', 'extruder', 'heater_bed', 'fan', 'gcode_move'];

class MoonrakerDriver extends PrinterDriver {
  static meta = {
    label: 'Klipper (Moonraker)',
    help: 'Voron, Creality K1 / Sonic Pad, Elegoo Neptune 4, Sovol, Qidi and other printers running Klipper with Moonraker (Mainsail or Fluidd).',
    fields: [
      { ...HOST_FIELD, help: 'Moonraker’s address. Port 7125 is used unless you give one, e.g. voron.local or 192.168.1.60:7125.' },
      { key: 'apiKey', label: 'API key', type: 'password', help: 'Only if Moonraker requires one (not needed for trusted LAN clients).' },
      { key: 'lightPin', label: 'Light pin', type: 'text', placeholder: 'caselight', help: 'Name of a Klipper [output_pin] that drives a light, to show a light switch.' },
      CAMERA_FIELD,
    ],
  };

  constructor(cfg, opts) {
    super(cfg, opts);
    this.base = baseUrl(cfg.host, 7125);
    this.limits = { nozzle: Number(cfg.maxNozzle) || 300, bed: Number(cfg.maxBed) || 120, jog: 100 };
    this.fileInfo = new Map(); // file -> { estimate, thumb }
    this.state.capabilities = {
      pause: true, resume: true, cancel: true, light: !!cfg.lightPin, files: true,
      control: { jog: true, home: true, motorsOff: true, temps: ['nozzle', 'bed'], fans: ['part'], speed: 'percent', limits: this.limits },
    };
  }

  async request(path, { method = 'GET', timeoutMs = 5000 } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: this.cfg.apiKey ? { 'X-Api-Key': this.cfg.apiKey } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `Moonraker ${path.split('?')[0]}: HTTP ${res.status}`);
    return body.result;
  }

  gcode(script) {
    return this.request(`/printer/gcode/script?script=${encodeURIComponent(script)}`, { method: 'POST', timeoutMs: 60000 });
  }

  async start() {
    const tick = async () => {
      try { await this.poll(); } catch (err) { this.setOffline(err); }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs); // stop() may land mid-poll
    };
    try { this.info = await this.request('/printer/info'); } catch { /* polled below */ }
    tick();
  }

  async stop() { this.stopped = true; clearTimeout(this.timer); }

  async fileMeta(file) {
    if (!file) return null;
    if (!this.fileInfo.has(file)) {
      this.fileInfo.set(file, null);
      try {
        const m = await this.request(`/server/files/metadata?filename=${encodeURIComponent(file)}`);
        const thumb = (m.thumbnails || []).sort((a, b) => b.width - a.width)[0];
        const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
        this.fileInfo.set(file, { estimate: m.estimated_time || null, thumb: thumb ? `${dir}${thumb.relative_path}` : null });
      } catch { /* no metadata for this file */ }
    }
    return this.fileInfo.get(file);
  }

  async poll() {
    const objects = [...OBJECTS, ...(this.cfg.lightPin ? [`output_pin ${this.cfg.lightPin}`] : [])];
    const q = objects.map((o) => encodeURIComponent(o)).join('&');
    const { status: s } = await this.request(`/printer/objects/query?${q}`);
    const ps = s.print_stats || {};
    const klippy = s.webhooks?.state || 'ready';
    const ext = s.extruder || {};
    const bed = s.heater_bed || {};
    const progress = (s.virtual_sdcard?.progress ?? s.display_status?.progress ?? 0) * 100;

    let status;
    if (klippy === 'startup') status = 'busy';
    else if (klippy !== 'ready') status = 'error';
    else {
      status = { standby: 'idle', printing: 'printing', paused: 'paused', complete: 'completed', cancelled: 'idle', error: 'error' }[ps.state] || 'idle';
      // Klipper says "printing" while the start G-code heats up.
      if (status === 'printing' && progress < 0.5 && ext.target > 0 && ext.temperature < ext.target - 5) status = 'heating';
    }

    const file = ['printing', 'heating', 'paused', 'completed'].includes(status) ? ps.filename : null;
    const meta = await this.fileMeta(file);
    const elapsed = ps.print_duration || 0;
    const remaining = meta?.estimate ? Math.max(0, meta.estimate - elapsed)
      : progress > 1 ? Math.round(elapsed / (progress / 100) - elapsed) : null;
    this.thumb = meta?.thumb || null;
    if (this.webcam === undefined) this.webcam = await this.findWebcam();

    this.update({
      online: true,
      status,
      error: status === 'error' ? (ps.message || s.webhooks?.state_message || 'Klipper reported an error') : null,
      model: this.cfg.model || this.info?.hostname || 'Klipper',
      firmware: this.info?.software_version || null,
      camera: this.cameraUrl() ? 'mjpeg' : null,
      light: this.cfg.lightPin ? (s[`output_pin ${this.cfg.lightPin}`]?.value || 0) > 0 : null,
      temps: {
        nozzle: { cur: ext.temperature ?? 0, target: ext.target ?? 0 },
        ...(s.heater_bed ? { bed: { cur: bed.temperature ?? 0, target: bed.target ?? 0 } } : {}),
      },
      fans: { part: s.fan ? Math.round((s.fan.speed || 0) * 100) : null },
      speed: ['printing', 'paused'].includes(status) ? { kind: 'percent', value: Math.round((s.gcode_move?.speed_factor || 1) * 100), min: 10, max: 300 } : null,
      job: file ? {
        file,
        progress: Math.round(progress * 10) / 10,
        layer: ps.info?.current_layer || 0,
        totalLayers: ps.info?.total_layer || 0,
        elapsed,
        remaining,
        thumb: !!this.thumb,
      } : null,
    });
  }

  async findWebcam() {
    try {
      const { webcams } = await this.request('/server/webcams/list');
      const cam = (webcams || []).find((w) => w.enabled !== false && w.stream_url);
      return cam ? { stream: this.absolute(cam.stream_url), snapshot: cam.snapshot_url ? this.absolute(cam.snapshot_url) : null } : false;
    } catch {
      return false;
    }
  }

  // Webcam URLs are usually relative to the web UI (port 80), not Moonraker.
  absolute(u) {
    if (/^https?:\/\//i.test(u)) return u;
    const b = new URL(this.base);
    return `${b.protocol}//${b.hostname}${u.startsWith('/') ? '' : '/'}${u}`;
  }

  async pause() { await this.request('/printer/print/pause', { method: 'POST' }); }
  async resume() { await this.request('/printer/print/resume', { method: 'POST' }); }
  async cancel() { await this.request('/printer/print/cancel', { method: 'POST' }); }

  // Back to "standby" after a finished print, like Mainsail/Fluidd's clear button.
  async clear() { await this.gcode('SDCARD_RESET_FILE'); }

  async setLight(on) {
    if (!this.cfg.lightPin) throw new Error('Set a light pin in this printer’s settings');
    await this.gcode(`SET_PIN PIN=${this.cfg.lightPin} VALUE=${on ? 1 : 0}`);
  }

  async listFiles() {
    const files = await this.request('/server/files/list?root=gcodes');
    return (files || []).sort((a, b) => b.modified - a.modified).map((f) => ({ name: f.path, size: f.size || null }));
  }

  async startPrint(file) {
    await this.request(`/printer/print/start?filename=${encodeURIComponent(file)}`, { method: 'POST' });
  }

  async upload(name, data) {
    if (!/\.(gcode|g|gco)$/i.test(name)) throw new Error('Klipper prints .gcode files');
    await postMultipart(`${this.base}/server/files/upload`, {
      fields: { root: 'gcodes' },
      file: { field: 'file', name, data },
      headers: this.cfg.apiKey ? { 'X-Api-Key': this.cfg.apiKey } : {},
    });
  }

  async control(raw) {
    const cmd = this.validateControl(raw);
    switch (cmd.action) {
      case 'jog': return this.gcode(`G91\nG1 ${cmd.axis.toUpperCase()}${cmd.distance} F${cmd.axis === 'z' ? 600 : 6000}\nG90`);
      case 'home': return this.gcode(cmd.axes === 'xyz' ? 'G28' : `G28 ${cmd.axes.toUpperCase().split('').join(' ')}`);
      case 'motorsOff': return this.gcode('M84');
      case 'temp': return this.gcode(cmd.heater === 'nozzle' ? `M104 S${cmd.target}` : `M140 S${cmd.target}`);
      case 'fan': return this.gcode(cmd.pct > 0 ? `M106 S${Math.round((cmd.pct / 100) * 255)}` : 'M107');
      case 'speed': return this.gcode(`M220 S${Math.max(10, Math.min(300, Math.round(Number(cmd.value))))}`);
      default: throw new Error('Unsupported');
    }
  }

  cameraUrl() {
    if (this.cfg.cameraUrl) return this.cfg.cameraUrl;
    return this.webcam ? this.webcam.stream : null;
  }

  cameraSource() {
    const url = this.cameraUrl();
    return url ? { url } : null;
  }

  snapshotSource() {
    if (this.cfg.cameraUrl) return { url: this.cfg.cameraUrl.replace('action=stream', 'action=snapshot') };
    const url = this.webcam?.snapshot || this.webcam?.stream?.replace('action=stream', 'action=snapshot');
    return url ? { url } : null;
  }

  thumbSource() {
    if (!this.thumb) return null;
    const path = this.thumb.split('/').map(encodeURIComponent).join('/');
    return { url: `${this.base}/server/files/gcodes/${path}`, headers: this.cfg.apiKey ? { 'X-Api-Key': this.cfg.apiKey } : {} };
  }
}

module.exports = { MoonrakerDriver };
