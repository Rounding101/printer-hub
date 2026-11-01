// Any printer connected to OctoPrint (Creality Ender/CR, Prusa MK3, Anycubic
// i3, Artillery and most other Marlin printers on a Raspberry Pi).
// Docs: https://docs.octoprint.org/en/master/api/
const { PrinterDriver, baseUrl, HOST_FIELD, CAMERA_FIELD } = require('./base');
const { postMultipart } = require('../lib/multipart');

class OctoPrintDriver extends PrinterDriver {
  static meta = {
    label: 'OctoPrint',
    help: 'Any printer connected to OctoPrint (or OctoPi), e.g. Creality Ender, Prusa MK3 and most Marlin printers.',
    fields: [
      { ...HOST_FIELD, placeholder: 'octopi.local', help: 'OctoPrint’s address, e.g. octopi.local or http://192.168.1.70:5000.' },
      { key: 'apiKey', label: 'API key', type: 'password', required: true, help: 'In OctoPrint: Settings → Application Keys (or the global API key under Settings → API).' },
      CAMERA_FIELD,
    ],
  };

  constructor(cfg, opts) {
    super(cfg, opts);
    this.base = baseUrl(cfg.host, 80);
    this.limits = { nozzle: Number(cfg.maxNozzle) || 280, bed: Number(cfg.maxBed) || 110, jog: 100 };
    this.state.capabilities = {
      pause: true, resume: true, cancel: true, light: false, files: true,
      control: { jog: true, home: true, motorsOff: true, temps: ['nozzle', 'bed'], fans: ['part'], speed: null, limits: this.limits },
    };
  }

  async request(path, { method = 'GET', body, timeoutMs = 5000, allow = [] } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'X-Api-Key': this.cfg.apiKey || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (allow.includes(res.status)) return { status: res.status };
    if (res.status === 403 || res.status === 401) throw new Error('OctoPrint refused the API key');
    if (!res.ok) throw new Error(`OctoPrint ${path.split('?')[0]}: ${(await res.text()).slice(0, 120) || `HTTP ${res.status}`}`);
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  }

  command(commands) {
    return this.request('/api/printer/command', { method: 'POST', body: { commands: [].concat(commands) } });
  }

  async start() {
    const tick = async () => {
      try { await this.poll(); } catch (err) { this.setOffline(err); }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs); // stop() may land mid-poll
    };
    tick();
  }

  async stop() { this.stopped = true; clearTimeout(this.timer); }

  async poll() {
    if (!this.version) this.version = await this.request('/api/version');
    if (this.webcam === undefined) this.webcam = await this.findWebcam();
    const printer = await this.request('/api/printer?exclude=sd', { allow: [409] });
    if (printer.status === 409) {
      // OctoPrint answers, but isn't connected to the printer's serial port.
      return this.update({ online: false, status: 'offline', error: 'OctoPrint isn’t connected to the printer', job: null });
    }
    const job = await this.request('/api/job');
    const f = printer.state?.flags || {};
    const t = printer.temperature || {};
    const done = (job.progress?.completion ?? 0) >= 100;
    let status = f.cancelling ? 'cancelling' : f.pausing ? 'pausing' : f.paused ? 'paused'
      : f.printing ? 'printing' : f.error || f.closedOrError ? 'error' : done && job.job?.file?.name ? 'completed' : 'idle';
    const progress = job.progress?.completion || 0;
    if (status === 'printing' && progress < 0.5 && t.tool0?.target > 0 && t.tool0.actual < t.tool0.target - 5) status = 'heating';
    const active = ['printing', 'heating', 'pausing', 'paused', 'cancelling', 'completed'].includes(status);

    this.update({
      online: true,
      status,
      error: status === 'error' ? printer.state?.text || 'Printer error' : null,
      model: this.cfg.model || 'OctoPrint',
      firmware: this.version?.server ? `OctoPrint ${this.version.server}` : null,
      camera: this.cameraUrl() ? 'mjpeg' : null,
      temps: {
        nozzle: { cur: t.tool0?.actual ?? 0, target: t.tool0?.target ?? 0 },
        ...(t.bed ? { bed: { cur: t.bed.actual ?? 0, target: t.bed.target ?? 0 } } : {}),
      },
      job: active && job.job?.file?.name ? {
        file: job.job.file.path || job.job.file.name,
        progress: Math.round(progress * 10) / 10,
        layer: 0,
        totalLayers: 0,
        elapsed: job.progress?.printTime ?? null,
        remaining: job.progress?.printTimeLeft ?? null,
        thumb: false,
      } : null,
    });
  }

  async findWebcam() {
    try {
      const s = await this.request('/api/settings');
      const cam = s.plugins?.classicwebcam || s.webcam || {};
      const stream = cam.stream || cam.streamUrl;
      if (!stream || s.webcam?.webcamEnabled === false) return false;
      const abs = (u) => (/^https?:\/\//i.test(u) ? u : `${new URL(this.base).origin}${u.startsWith('/') ? '' : '/'}${u}`);
      const snap = cam.snapshot || cam.snapshotUrl;
      return { stream: abs(stream), snapshot: snap ? abs(snap) : null };
    } catch {
      return false;
    }
  }

  async pause() { await this.request('/api/job', { method: 'POST', body: { command: 'pause', action: 'pause' } }); }
  async resume() { await this.request('/api/job', { method: 'POST', body: { command: 'pause', action: 'resume' } }); }
  async cancel() { await this.request('/api/job', { method: 'POST', body: { command: 'cancel' } }); }

  async listFiles() {
    const { files = [] } = await this.request('/api/files/local?recursive=true');
    const out = [];
    const walk = (list) => {
      for (const f of list) {
        if (f.type === 'folder') walk(f.children || []);
        else if (f.type === 'machinecode') out.push({ name: f.path, size: f.size || null, printTime: f.gcodeAnalysis?.estimatedPrintTime || null, date: f.date });
      }
    };
    walk(files);
    return out.sort((a, b) => (b.date || 0) - (a.date || 0)).map(({ date, ...f }) => f);
  }

  async startPrint(file) {
    const path = file.split('/').map(encodeURIComponent).join('/');
    await this.request(`/api/files/local/${path}`, { method: 'POST', body: { command: 'select', print: true } });
  }

  async upload(name, data) {
    if (!/\.(gcode|g|gco)$/i.test(name)) throw new Error('OctoPrint prints .gcode files');
    await postMultipart(`${this.base}/api/files/local`, {
      file: { field: 'file', name, data },
      headers: { 'X-Api-Key': this.cfg.apiKey || '' },
    });
  }

  async control(raw) {
    const cmd = this.validateControl(raw);
    switch (cmd.action) {
      case 'jog': return this.request('/api/printer/printhead', { method: 'POST', body: { command: 'jog', [cmd.axis]: cmd.distance } });
      case 'home': return this.request('/api/printer/printhead', { method: 'POST', body: { command: 'home', axes: cmd.axes.split('') } });
      case 'motorsOff': return this.command('M18');
      case 'temp':
        return cmd.heater === 'nozzle'
          ? this.request('/api/printer/tool', { method: 'POST', body: { command: 'target', targets: { tool0: cmd.target } } })
          : this.request('/api/printer/bed', { method: 'POST', body: { command: 'target', target: cmd.target } });
      case 'fan': return this.command(cmd.pct > 0 ? `M106 S${Math.round((cmd.pct / 100) * 255)}` : 'M107');
      default: throw new Error('Unsupported');
    }
  }

  // OctoPrint's own rendered timelapses.
  async listTimelapses() {
    const { files = [] } = await this.request('/api/timelapse?unrendered=false').catch(() => ({}));
    return files.map((f) => ({ name: f.name, size: f.bytes ?? null, date: f.date ? Date.parse(f.date.replace(' ', 'T')) || null : null, url: f.url }));
  }

  timelapseSource(name) {
    return { url: `${this.base}/downloads/timelapse/${encodeURIComponent(name)}`, headers: { 'X-Api-Key': this.cfg.apiKey || '' } };
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
    const url = this.cfg.cameraUrl
      ? this.cfg.cameraUrl.replace('action=stream', 'action=snapshot')
      : this.webcam?.snapshot || this.webcam?.stream?.replace('action=stream', 'action=snapshot');
    return url ? { url } : null;
  }
}

module.exports = { OctoPrintDriver };
