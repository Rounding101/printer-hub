// Prusa printers through PrusaLink (MK4/S, MK3.9, XL, MINI+, Core One).
// Docs: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
// Recent firmware uses HTTP Digest auth (user "maker"); older builds an API key.
const crypto = require('node:crypto');
const { PrinterDriver, baseUrl, HOST_FIELD, CAMERA_FIELD } = require('./base');

const STATUS = {
  IDLE: 'idle', READY: 'idle', BUSY: 'busy', PRINTING: 'printing', PAUSED: 'paused',
  FINISHED: 'completed', STOPPED: 'idle', ERROR: 'error', ATTENTION: 'error',
};
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

class PrusaLinkDriver extends PrinterDriver {
  static meta = {
    label: 'Prusa (PrusaLink)',
    help: 'Prusa MK4/S, MK3.9, XL, MINI+ and Core One with PrusaLink turned on.',
    fields: [
      { ...HOST_FIELD, help: 'The printer’s IP address (shown on its screen under Settings → Network).' },
      { key: 'username', label: 'Username', type: 'text', placeholder: 'maker' },
      { key: 'password', label: 'Password', type: 'password', help: 'The PrusaLink password from the printer’s screen (Settings → Network → PrusaLink).' },
      { key: 'apiKey', label: 'API key (older firmware)', type: 'password', help: 'Only for firmware that shows an API key instead of a password.' },
      CAMERA_FIELD,
    ],
  };

  constructor(cfg, opts) {
    super(cfg, opts);
    this.base = baseUrl(cfg.host, 80);
    this.digest = null; // { realm, nonce, qop, opaque, nc }
    // PrusaLink has no G-code or motion API, so there's no manual control.
    this.state.capabilities = { pause: true, resume: true, cancel: true, light: false, files: true };
  }

  authHeader(method, uri) {
    if (this.cfg.apiKey && !this.cfg.password) return { 'X-Api-Key': this.cfg.apiKey };
    const d = this.digest;
    if (!d) return {};
    d.nc += 1;
    const nc = d.nc.toString(16).padStart(8, '0');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const user = this.cfg.username || 'maker';
    const ha1 = md5(`${user}:${d.realm}:${this.cfg.password || ''}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = d.qop
      ? md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:auth:${ha2}`)
      : md5(`${ha1}:${d.nonce}:${ha2}`);
    const parts = [`username="${user}"`, `realm="${d.realm}"`, `nonce="${d.nonce}"`, `uri="${uri}"`, `response="${response}"`];
    if (d.qop) parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
    if (d.opaque) parts.push(`opaque="${d.opaque}"`);
    return { Authorization: `Digest ${parts.join(', ')}` };
  }

  async request(path, { method = 'GET', body, headers = {}, timeoutMs = 5000, raw = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(this.base + path, {
        method,
        headers: { ...headers, ...this.authHeader(method, path) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const challenge = res.headers.get('www-authenticate');
      if (res.status === 401 && attempt === 0 && /^Digest/i.test(challenge || '') && this.cfg.password) {
        const kv = Object.fromEntries([...challenge.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1].toLowerCase(), m[2]]));
        this.digest = { realm: kv.realm, nonce: kv.nonce, qop: /auth/.test(kv.qop || '') ? 'auth' : null, opaque: kv.opaque, nc: 0 };
        continue;
      }
      if (res.status === 401) throw new Error('PrusaLink refused the password');
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`PrusaLink ${path}: HTTP ${res.status}`);
      return raw ? res : res.json().catch(() => ({}));
    }
    throw new Error('PrusaLink refused the password');
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
    if (!this.version) this.version = await this.request('/api/version').catch(() => ({}));
    const s = await this.request('/api/v1/status');
    const p = s.printer || {};
    const status = STATUS[p.state] || 'busy';
    const job = s.job ? await this.request('/api/v1/job') : null;
    this.jobId = job?.id ?? s.job?.id ?? null;
    this.thumb = job?.file?.refs?.thumbnail || null;
    this.storage = (s.storage?.path || this.storage || '/usb').replace(/\/+$/, '');

    this.update({
      online: true,
      status,
      error: status === 'error' ? `Printer needs attention (${p.state.toLowerCase()})` : null,
      model: this.cfg.model || this.version?.hostname || 'Prusa',
      firmware: this.version?.firmware || null,
      camera: this.cfg.cameraUrl ? 'mjpeg' : null,
      temps: {
        nozzle: { cur: p.temp_nozzle ?? 0, target: p.target_nozzle ?? 0 },
        bed: { cur: p.temp_bed ?? 0, target: p.target_bed ?? 0 },
      },
      job: job ? {
        file: job.file?.display_name || job.file?.name || '',
        progress: job.progress ?? s.job?.progress ?? 0,
        layer: 0,
        totalLayers: 0,
        elapsed: job.time_printing ?? null,
        remaining: job.time_remaining ?? null,
        thumb: !!this.thumb,
      } : null,
    });
  }

  async jobAction(action) {
    if (this.jobId == null) throw new Error('No job is running');
    if (action === 'stop') await this.request(`/api/v1/job/${this.jobId}`, { method: 'DELETE' });
    else await this.request(`/api/v1/job/${this.jobId}/${action}`, { method: 'PUT' });
  }

  async pause() { await this.jobAction('pause'); }
  async resume() { await this.jobAction('resume'); }
  async cancel() { await this.jobAction('stop'); }

  async listFiles() {
    const out = [];
    const walk = async (path, depth) => {
      const dir = await this.request(`/api/v1/files${path.split('/').map(encodeURIComponent).join('/')}`);
      for (const c of dir?.children || []) {
        const child = `${path}/${c.name}`;
        if (c.type === 'FOLDER' && depth < 2) await walk(child, depth + 1);
        else if (c.type === 'PRINT_FILE') out.push({ name: child.slice(this.storage.length + 1), size: c.size || null, t: c.m_timestamp || 0 });
      }
    };
    await walk(this.storage || '/usb', 0);
    return out.sort((a, b) => b.t - a.t).map(({ t, ...f }) => f);
  }

  filePath(name) {
    return `/api/v1/files${`${this.storage || '/usb'}/${name}`.split('/').map(encodeURIComponent).join('/')}`;
  }

  async startPrint(file) {
    await this.request(this.filePath(file), { method: 'POST' });
  }

  async upload(name, data) {
    if (!/\.(bgcode|gcode)$/i.test(name)) throw new Error('Prusa printers take .bgcode or .gcode files');
    await this.request(this.filePath(name), {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': 'application/octet-stream', 'Print-After-Upload': '?0', Overwrite: '?1' },
      timeoutMs: 300000,
    });
  }

  cameraSource() { return this.cfg.cameraUrl ? { url: this.cfg.cameraUrl } : null; }
  snapshotSource() { return this.cfg.cameraUrl ? { url: this.cfg.cameraUrl.replace('action=stream', 'action=snapshot') } : null; }

  thumbSource() {
    return this.thumb ? { url: this.base + this.thumb, headers: this.authHeader('GET', this.thumb) } : null;
  }
}

module.exports = { PrusaLinkDriver };
