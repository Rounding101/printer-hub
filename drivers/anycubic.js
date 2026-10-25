// Anycubic Kobra X / Kobra 3 / S1 family in stock-firmware LAN Mode.
//
// Handshake: GET http://<host>:18910/info, then a signed POST to the returned
// ctrlInfoUrl; the AES-CBC encrypted reply holds MQTT credentials and a client
// certificate. Status and commands then go over MQTT/TLS (port 9883).
// Protocol reference: https://github.com/rvanderp3/kobra-connect
const crypto = require('node:crypto');
const mqtt = require('mqtt');
const { PrinterDriver } = require('./base');

const PREFIX = 'anycubic/anycubicCloud/v1';
const PAUSE = { PRINTING: 0, PAUSED: 1, PAUSING: 2, RESUMING: 3, STOPPING: 4 };

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const randStr = (n, chars) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');

async function getJson(method, url) {
  const res = await fetch(url, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function handshake(host) {
  const info = await getJson('GET', `http://${host}:18910/info`);
  if (info.ctrlType === 'cloud') throw new Error('Printer is in cloud mode — enable LAN Mode on the printer');
  const { token, ctrlInfoUrl, modelId } = info;
  if (!token || !ctrlInfoUrl || !modelId) throw new Error('Printer does not support the LAN Mode handshake');

  const ts = Date.now();
  const nonce = randStr(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
  const did = randStr(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const sign = md5(md5(token.slice(0, 16)) + ts + nonce);
  const qs = new URLSearchParams({ ts, nonce, sign, did });
  const ctrl = await getJson('POST', `${ctrlInfoUrl}?${qs}`);
  if (ctrl.code !== 200) throw new Error(`LAN handshake failed: ${ctrl.message || ctrl.code}`);

  const iv = Buffer.alloc(16);
  Buffer.from(ctrl.data.token).copy(iv, 0, 0, 16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(token.slice(16, 32)), iv);
  const plain = Buffer.concat([decipher.update(Buffer.from(ctrl.data.info, 'base64')), decipher.final()]);
  const data = JSON.parse(plain.toString('utf8'));

  const m = /mqtts?:\/\/([^:]+):(\d+)/.exec(data.broker);
  if (!m) throw new Error(`Unexpected broker URL: ${data.broker}`);
  return {
    brokerHost: m[1],
    brokerPort: +m[2],
    username: data.username,
    password: data.password,
    deviceId: data.deviceId,
    modelId: String(modelId),
    cert: data.devicecrt,
    key: data.devicepk,
    modelName: info.modelName || null,
  };
}

function mapStatus(infoState, project) {
  const ps = project?.state?.toLowerCase();
  if (ps === 'printing') {
    if (project.pause === PAUSE.PAUSED) return 'paused';
    if (project.pause === PAUSE.PAUSING) return 'pausing';
    if (project.pause === PAUSE.STOPPING) return 'cancelling';
    return 'printing';
  }
  if (ps === 'paused') return 'paused';
  if (ps === 'finish' || ps === 'finished' || ps === 'complete') return 'completed';
  if (ps === 'preheating' || ps === 'heating') return 'heating';
  const s = (infoState || '').toLowerCase();
  if (s === 'free' || s === 'idle' || s === 'ready') return 'idle';
  if (s === 'printing') return 'printing';
  if (s === 'error') return 'error';
  return s ? 'busy' : 'idle';
}

class AnycubicDriver extends PrinterDriver {
  constructor(cfg, opts) {
    super(cfg, opts);
    this.state.capabilities = { pause: true, resume: true, cancel: true, light: true, files: true };
    this.info = {};
    this.project = null;
    this.light = null;
    // Replies carry their own msgid (after an empty ack echoing ours), so we
    // match pending requests by "type:action" instead.
    this.pending = new Map();
  }

  async start() {
    this.stopped = false;
    this.connect();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
    this.client?.end(true);
  }

  async connect() {
    try {
      this.hs = await handshake(this.cfg.host);
    } catch (err) {
      this.setOffline(err);
      this.retryTimer = setTimeout(() => this.connect(), 15000);
      return;
    }
    const { brokerHost, brokerPort, username, password, cert, key, modelId, deviceId } = this.hs;
    this.client = mqtt.connect({
      protocol: 'mqtts',
      host: brokerHost,
      port: brokerPort,
      username,
      password,
      cert,
      key,
      rejectUnauthorized: false, // printer uses a self-signed broker cert
      clientId: `printer-hub-${crypto.randomBytes(4).toString('hex')}`,
      reconnectPeriod: 0, // reconnect via a fresh handshake instead; credentials may rotate
      connectTimeout: 10000,
    });
    this.client.on('connect', () => {
      this.client.subscribe(`${PREFIX}/printer/public/${modelId}/${deviceId}/#`);
      this.update({ online: true, error: null, model: this.hs.modelName });
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), Math.max(this.pollIntervalMs, 2000));
    });
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    const client = this.client;
    const lost = (err) => {
      if (this.client !== client) return; // already handled (error + close both fire)
      clearInterval(this.pollTimer);
      client.removeAllListeners();
      client.on('error', () => {});
      client.end(true);
      this.client = null;
      this.setOffline(err || new Error('Connection lost'));
      if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), 10000);
    };
    this.client.on('error', lost);
    this.client.on('close', () => lost());
  }

  publish(channel, type, action, data) {
    if (!this.client?.connected) throw new Error('Printer not connected');
    const msgid = crypto.randomUUID();
    const topic = `${PREFIX}/${channel}/printer/${this.hs.modelId}/${this.hs.deviceId}/${type}`;
    this.client.publish(topic, JSON.stringify({ type, action, timestamp: Date.now(), msgid, data }));
    return msgid;
  }

  poll() {
    try {
      this.publish('web', 'info', 'query', null);
      this.publish('web', 'light', 'query', null);
    } catch { /* reconnect handled elsewhere */ }
  }

  onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (!topic.endsWith('/report') || !msg.type) return; // skip empty acks
    const type = topic.split('/').slice(-2, -1)[0];
    const d = msg.data || {};

    const key = `${msg.type}:${msg.action}`;
    if (this.pending.has(key)) {
      this.pending.get(key)(msg);
      this.pending.delete(key);
    }

    if (type === 'light') {
      const l = (d.lights || [])[0];
      if (!l) return;
      this.light = !!l.status;
    } else if (type === 'info') {
      this.info = d;
      if ('project' in d) this.project = d.project || null;
    } else if (type === 'print' && d && (d.filename || d.progress != null)) {
      this.project = { ...(this.project || {}), ...d, state: d.state || msg.state || this.project?.state };
    } else if (type === 'tempature') {
      this.info = { ...this.info, temp: d };
    } else {
      return;
    }
    this.render();
  }

  render() {
    const t = this.info.temp || {};
    const p = this.project;
    const status = mapStatus(this.info.state, p);
    const active = ['printing', 'pausing', 'paused', 'cancelling', 'heating', 'completed'].includes(status);
    this.update({
      online: true,
      status,
      error: status === 'error' ? 'Printer reported an error' : null,
      model: this.info.model || this.hs?.modelName || 'Anycubic',
      firmware: this.info.version || null,
      camera: this.cameraUrl() ? 'flv' : null,
      light: this.light,
      temps: {
        nozzle: { cur: t.curr_nozzle_temp ?? 0, target: t.target_nozzle_temp ?? 0 },
        bed: { cur: t.curr_hotbed_temp ?? 0, target: t.target_hotbed_temp ?? 0 },
      },
      job: active && p ? {
        file: p.filename || '',
        progress: p.progress || 0,
        layer: p.curr_layer || 0,
        totalLayers: p.total_layers || 0,
        elapsed: p.print_time != null ? p.print_time * 60 : null, // printer reports minutes
        remaining: p.remain_time != null ? p.remain_time * 60 : null,
        thumb: false,
      } : null,
    });
  }

  // Publishes a command and resolves with the printer's report for it; rejects
  // if the printer reports failure.
  request(type, action, data, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const key = `${type}:${action}`;
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('Printer did not respond')); }, timeoutMs);
      this.pending.set(key, (msg) => {
        clearTimeout(timer);
        if (msg.state === 'failed' || (msg.code && msg.code !== 200)) reject(new Error(`Printer refused ${action} (code ${msg.code})`));
        else resolve(msg);
      });
      try { this.publish('web', type, action, data); } catch (err) { clearTimeout(timer); this.pending.delete(key); reject(err); }
    });
  }

  taskId() {
    return String(this.project?.taskid ?? this.project?.task_id ?? '-1');
  }

  async pause() { this.publish('web', 'print', 'pause', { taskid: this.taskId() }); }
  async resume() { this.publish('web', 'print', 'resume', { taskid: this.taskId() }); }
  async cancel() { this.publish('web', 'print', 'stop', { taskid: this.taskId() }); }

  async setLight(on) {
    await this.request('light', 'control', { type: 3, status: on ? 1 : 0, brightness: on ? 100 : 0 });
    this.light = on;
    this.render();
  }

  async listFiles() {
    // Paging params are required, but the Kobra X may ignore them and return
    // everything each time, so stop as soon as a page adds nothing new.
    const files = new Map();
    const pageSize = 50;
    for (let page = 1; page <= 20; page++) {
      const msg = await this.request('file', 'listLocal', { root: 'local', path: '/', page_num: page, page_size: pageSize });
      const records = (msg.data?.records || []).filter((f) => !f.is_dir);
      const before = files.size;
      for (const f of records) files.set(f.fileKey || f.filename, f);
      if (records.length < pageSize || files.size === before) break;
    }
    return [...files.values()]
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .map((f) => ({ name: f.filename, size: f.size || null }));
  }

  async startPrint(filename) {
    await this.request('print', 'start', { filename, filetype: 1, taskid: '-1' }, 15000);
  }

  cameraUrl() {
    if (this.cfg.cameraUrl === false) return null;
    return this.cfg.cameraUrl || this.info.urls?.rtspUrl || `http://${this.cfg.host}:18088/flv`;
  }

  cameraSource() {
    // Ask the printer to start its camera feed; harmless if it is already running.
    try { this.publish('web', 'video', 'startCapture', null); } catch { /* offline */ }
    const url = this.cameraUrl();
    return url ? { url } : null;
  }

  snapshotSource() {
    return { url: `http://${this.cfg.host}:18910/camera/snapshot` };
  }
}

module.exports = { AnycubicDriver, handshake };
