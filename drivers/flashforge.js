// FlashForge Adventurer 5M / 5M Pro.
//
// Preferred: the local HTTP API on port 8898, which needs the printer's serial
// number and the "check code" shown when LAN mode is enabled on the printer.
// Fallback (no check code configured): the legacy G-code-over-TCP API on port
// 8899, which needs no credentials but reports less detail.
const net = require('node:net');
const { PrinterDriver, HOST_FIELD, CAMERA_FIELD } = require('./base');
const { postMultipart } = require('../lib/multipart');

const HTTP_PORT = 8898;
const TCP_PORT = 8899;

const HTTP_STATUS = {
  ready: 'idle',
  busy: 'busy',
  calibrate_doing: 'busy',
  heating: 'heating',
  printing: 'printing',
  pausing: 'pausing',
  paused: 'paused',
  cancel: 'cancelling',
  completed: 'completed',
  error: 'error',
};

const TCP_STATUS = {
  READY: 'idle',
  BUILDING_FROM_SD: 'printing',
  BUILDING_COMPLETED: 'completed',
  PAUSED: 'paused',
  BUSY: 'busy',
};

class FlashForgeDriver extends PrinterDriver {
  static meta = {
    label: 'FlashForge Adventurer 5M / 5M Pro',
    help: 'Stock firmware with LAN-only mode on. Without the serial and check code you still get status and pause/resume/cancel.',
    slicer: { vendor: 'Flashforge', machine: 'Flashforge Adventurer 5M 0.4 Nozzle' },
    fields: [
      { ...HOST_FIELD, help: 'The printer’s IP address.' },
      { key: 'serialNumber', label: 'Serial number', type: 'text', help: 'On the printer under About / device info.' },
      { key: 'checkCode', label: 'Check code', type: 'password', help: 'Shown on the printer’s screen when you turn on LAN-only mode.' },
      { key: 'levelBeforePrint', label: 'Auto-level before prints started from the hub', type: 'checkbox' },
      { ...CAMERA_FIELD, help: 'Defaults to the 5M Pro’s camera on port 8080.' },
    ],
  };

  constructor(cfg, opts) {
    super(cfg, opts);
    this.mode = cfg.checkCode && cfg.serialNumber ? 'http' : 'tcp';
    this.detail = null;
    this.limits = { nozzle: 280, bed: 110, jog: 100 };
    this.state.capabilities = {
      pause: true,
      resume: true,
      cancel: true,
      light: this.mode === 'http',
      files: this.mode === 'http',
      control: { jog: true, home: true, motorsOff: true, temps: ['nozzle', 'bed'], fans: ['part'], speed: this.mode === 'http' ? 'percent' : null, limits: this.limits },
    };
  }

  async start() {
    const tick = async () => {
      try {
        if (this.mode === 'http') await this.pollHttp();
        else await this.pollTcp();
      } catch (err) {
        this.setOffline(err);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs); // stop() may land mid-poll
    };
    tick();
  }

  async stop() { this.stopped = true; clearTimeout(this.timer); }

  // ---- HTTP API (port 8898) ----------------------------------------------

  async post(path, extra = {}) {
    const res = await fetch(`http://${this.cfg.host}:${HTTP_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serialNumber: this.cfg.serialNumber, checkCode: this.cfg.checkCode, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    if (body.code !== 0) throw new Error(body.message || `FlashForge ${path} failed (code ${body.code})`);
    return body;
  }

  async pollHttp() {
    const { detail: d } = await this.post('/detail');
    this.detail = d;
    const status = HTTP_STATUS[d.status] || 'busy';
    const hasJob = ['printing', 'pausing', 'paused', 'heating', 'cancelling', 'completed'].includes(status) && d.printFileName;
    this.update({
      online: true,
      error: d.errorCode && d.errorCode !== '0' ? `Printer error ${d.errorCode}` : null,
      status,
      model: d.name || 'Adventurer 5M',
      firmware: d.firmwareVersion || null,
      light: d.lightStatus === 'open',
      camera: this.cameraUrl() ? 'mjpeg' : null,
      temps: {
        nozzle: { cur: d.rightTemp || d.leftTemp || 0, target: d.rightTargetTemp || d.leftTargetTemp || 0 },
        bed: { cur: d.platTemp || 0, target: d.platTargetTemp || 0 },
        ...(d.chamberTemp ? { chamber: { cur: d.chamberTemp, target: d.chamberTargetTemp || 0 } } : {}),
      },
      fans: {
        part: d.coolingFanSpeed ?? null,
        ...(d.chamberFanSpeed ? { chamber: d.chamberFanSpeed } : {}),
      },
      speed: ['printing', 'pausing', 'paused'].includes(status) && d.printSpeedAdjust != null
        ? { kind: 'percent', value: d.printSpeedAdjust, min: 50, max: 150 }
        : null,
      job: hasJob ? {
        file: d.printFileName,
        progress: Math.round((d.printProgress || 0) * 1000) / 10,
        layer: d.printLayer || 0,
        totalLayers: d.targetPrintLayer || 0,
        elapsed: d.printDuration || 0,
        remaining: d.estimatedTime || 0,
        grams: d.estimatedRightWeight || d.estimatedLeftWeight || null, // slicer's filament estimate for the job
        thumb: !!d.printFileThumbUrl,
      } : null,
    });
  }

  async httpControl(cmd, args) {
    if (this.mode !== 'http') throw new Error('Needs serialNumber + checkCode in config for this command');
    await this.post('/control', { payload: { cmd, args } });
  }

  // ---- Legacy TCP API (port 8899) ----------------------------------------

  tcp(commands) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.cfg.host, port: TCP_PORT });
      const replies = [];
      const queue = ['~M601 S1', ...commands, '~M602'];
      let buf = '';
      const done = (err) => { sock.destroy(); clearTimeout(timer); err ? reject(err) : resolve(replies.slice(1, -1)); };
      const timer = setTimeout(() => done(new Error('TCP timeout')), 6000);
      const next = () => {
        if (!queue.length) return done();
        sock.write(queue.shift() + '\r\n');
      };
      sock.on('connect', next);
      sock.on('error', done);
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        while (/\bok\r?\n/.test(buf)) {
          const i = buf.search(/\bok\r?\n/);
          const end = buf.indexOf('\n', i) + 1;
          replies.push(buf.slice(0, end));
          buf = buf.slice(end);
          next();
        }
      });
    });
  }

  async pollTcp() {
    const [info, status, progress, temps] = await this.tcp(['~M115', '~M119', '~M27', '~M105']);
    const field = (text, key) => (text.match(new RegExp(`${key}:\\s*(.*)`)) || [])[1]?.trim();
    const machine = field(status, 'MachineStatus');
    const moveMode = field(status, 'MoveMode');
    let st = TCP_STATUS[machine] || 'busy';
    if (moveMode === 'PAUSED') st = 'paused';
    const pct = (progress.match(/byte\s+(\d+)\/(\d+)/) || []);
    const layer = (progress.match(/Layer:\s*(\d+)\/(\d+)/) || []);
    const t = (k) => {
      const m = temps.match(new RegExp(`${k}:\\s*([\\d.]+)\\s*/\\s*([\\d.]+)`));
      return m ? { cur: +m[1], target: +m[2] } : { cur: 0, target: 0 };
    };
    const file = field(status, 'CurrentFile');
    this.update({
      online: true,
      error: null,
      status: st,
      model: field(info, 'Machine Type') || 'Adventurer 5M',
      firmware: field(info, 'Firmware') || null,
      light: null,
      camera: this.cameraUrl() ? 'mjpeg' : null,
      temps: { nozzle: t('T0'), bed: t('B') },
      job: ['printing', 'paused', 'completed'].includes(st) && file ? {
        file,
        progress: pct[2] ? Math.round((+pct[1] / +pct[2]) * 1000) / 10 : 0,
        layer: +layer[1] || 0,
        totalLayers: +layer[2] || 0,
        elapsed: null,
        remaining: null,
        thumb: false,
      } : null,
    });
  }

  // ---- Commands ------------------------------------------------------------

  async pause() {
    if (this.mode === 'http') return this.httpControl('jobCtl_cmd', { jobID: '', action: 'pause' });
    await this.tcp(['~M25']);
  }

  async resume() {
    if (this.mode === 'http') return this.httpControl('jobCtl_cmd', { jobID: '', action: 'continue' });
    await this.tcp(['~M24']);
  }

  async cancel() {
    if (this.mode === 'http') return this.httpControl('jobCtl_cmd', { jobID: '', action: 'cancel' });
    await this.tcp(['~M26']);
  }

  // Motion, temperatures and fans go over the G-code TCP API (the AD5M runs
  // Klipper underneath, so standard G-code applies). Print speed uses the HTTP
  // API's printerCtl_cmd, which also carries the current fan/Z-offset values.
  async control(raw) {
    const cmd = this.validateControl(raw);
    switch (cmd.action) {
      case 'jog': {
        const feed = cmd.axis === 'z' ? 600 : 3000;
        return this.tcp(['~G91', `~G1 ${cmd.axis.toUpperCase()}${cmd.distance} F${feed}`, '~G90']);
      }
      case 'home':
        return this.tcp([cmd.axes === 'xyz' ? '~G28' : `~G28 ${cmd.axes.toUpperCase().split('').join(' ')}`]);
      case 'motorsOff':
        return this.tcp(['~M18']);
      case 'temp':
        return this.tcp([cmd.heater === 'nozzle' ? `~M104 S${cmd.target} T0` : `~M140 S${cmd.target}`]);
      case 'fan':
        return this.tcp([cmd.pct > 0 ? `~M106 S${Math.round((cmd.pct / 100) * 255)}` : '~M107']);
      case 'speed': {
        if (this.mode !== 'http') throw new Error('Speed control needs serialNumber + checkCode');
        const d = this.detail || {};
        const speed = Math.max(50, Math.min(150, Math.round(Number(cmd.value))));
        return this.httpControl('printerCtl_cmd', {
          zAxisCompensation: d.zAxisCompensation ?? 0,
          speed,
          chamberFan: d.chamberFanSpeed ?? 0,
          coolingFan: d.coolingFanSpeed ?? 0,
          coolingLeftFan: 0,
        });
      }
      default:
        throw new Error('Unsupported');
    }
  }

  // Dismisses the "print complete / clear the platform" prompt (also on the
  // printer's screen) and returns it to ready.
  async clear() {
    if (this.mode === 'http') await this.httpControl('stateCtrl_cmd', { action: 'setClearPlatform' });
  }

  async setLight(on) {
    await this.httpControl('lightControl_cmd', { status: on ? 'open' : 'close' });
  }

  async listFiles() {
    if (this.mode !== 'http') return [];
    const body = await this.post('/gcodeList');
    if (Array.isArray(body.gcodeListDetail)) {
      return body.gcodeListDetail.map((f) => ({ name: f.gcodeFileName, printTime: f.totalPrintTime || null }));
    }
    return (body.gcodeList || []).map((name) => ({ name }));
  }

  async printOptions() {
    return {
      colors: [],
      slots: [],
      options: [{ key: 'autoLevel', label: 'Auto-level before printing', default: !!this.cfg.levelBeforePrint }],
    };
  }

  async startPrint(fileName, { autoLevel = !!this.cfg.levelBeforePrint } = {}) {
    if (this.mode !== 'http') throw new Error('Needs serialNumber + checkCode in config to start prints');
    await this.post('/printGcode', { fileName, levelingBeforePrint: !!autoLevel });
  }

  async upload(fileName, data) {
    if (this.mode !== 'http') throw new Error('Needs serialNumber + checkCode in config to upload files');
    if (!/\.(gcode|gx|3mf)$/i.test(fileName)) throw new Error('The AD5M accepts .gcode, .gx and .3mf files');
    const res = await postMultipart(`http://${this.cfg.host}:${HTTP_PORT}/uploadGcode`, {
      file: { field: 'gcodeFile', name: fileName, data },
      expectContinue: true,
      headers: {
        serialNumber: this.cfg.serialNumber,
        checkCode: this.cfg.checkCode,
        fileSize: String(data.length),
        printNow: 'false',
        levelingBeforePrint: 'false',
        flowCalibration: 'false',
        useMatlStation: 'false',
        gcodeToolCnt: '0',
        materialMappings: Buffer.from('[]').toString('base64'),
      },
    });
    if (res.code !== 0) throw new Error(res.message || `Printer rejected the upload (code ${res.code})`);
  }

  cameraUrl() {
    if (this.cfg.cameraUrl === false) return null;
    return this.cfg.cameraUrl || this.detail?.cameraStreamUrl || `http://${this.cfg.host}:8080/?action=stream`;
  }

  cameraSource() {
    const url = this.cameraUrl();
    return url ? { url } : null;
  }

  snapshotSource() {
    const url = this.cameraUrl();
    return url ? { url: url.replace('action=stream', 'action=snapshot') } : null;
  }

  thumbSource() {
    const url = this.detail?.printFileThumbUrl;
    return url ? { url } : null;
  }
}

module.exports = { FlashForgeDriver };
