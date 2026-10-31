// Slicer service: wraps the OrcaSlicer CLI behind a small HTTP API for the hub.
// Input and output files live on the shared /data volume, so only paths and
// settings cross the wire.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ProfileStore } = require('./profiles');

const PORT = Number(process.env.PORT) || 8080;
const ORCA_BIN = process.env.ORCA_BIN || '/opt/orca/AppRun';
const STEP2STL_BIN = process.env.STEP2STL_BIN || '/opt/step2stl/step2stl';
const PROFILES_DIR = process.env.PROFILES_DIR || '/opt/orca/resources/profiles';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const ORCA_HOME = process.env.ORCA_HOME || '/tmp/orca-home';
const TIMEOUT_MS = Number(process.env.SLICE_TIMEOUT_MS) || 20 * 60 * 1000;
const MODEL_EXT = /\.(stl|obj|3mf|step|stp|amf)$/i;
// Orca's curr_bed_type values and their GUI labels.
const BED_TYPES = [
  { value: 'Textured PEI Plate', label: 'Textured PEI Plate' },
  { value: 'High Temp Plate', label: 'Smooth PEI / High Temp Plate' },
  { value: 'Cool Plate', label: 'Smooth Cool Plate' },
  { value: 'Textured Cool Plate', label: 'Textured Cool Plate' },
  { value: 'Engineering Plate', label: 'Engineering Plate' },
  { value: 'Supertack Plate', label: 'Cool Plate (SuperTack)' },
];

const store = new ProfileStore(PROFILES_DIR);
const version = (() => {
  try { return fs.readFileSync(path.join(path.dirname(PROFILES_DIR), '..', 'VERSION'), 'utf8').trim(); } catch { return process.env.ORCA_VERSION || 'unknown'; }
})();

// Settings the hub's slice dialog may override on the process preset.
const PROCESS_OVERRIDES = {
  infill: (v) => ({ sparse_infill_density: `${Math.max(0, Math.min(100, Number(v) || 0))}%` }),
  supports: (v) => (v === 'off' || !v
    ? { enable_support: '0' }
    : { enable_support: '1', support_type: v === 'tree' ? 'tree(auto)' : 'normal(auto)' }),
  brim: (v) => ({ brim_type: v ? 'auto_brim' : 'no_brim' }),
  walls: (v) => ({ wall_loops: String(Math.max(1, Math.min(10, Number(v) || 2))) }),
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}

function insideData(p) {
  const abs = path.resolve(p);
  if (!abs.startsWith(DATA_DIR + path.sep)) throw new Error('Input must be on the shared data volume');
  return abs;
}

function rgbFromHex(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Reads the stats Orca writes into the G-code header/footer.
function gcodeStats(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (pos, len) => { const b = Buffer.alloc(Math.min(len, size)); fs.readSync(fd, b, 0, b.length, pos); return b.toString('latin1'); };
  const text = read(0, 64 * 1024) + '\n' + read(Math.max(0, size - 256 * 1024), 256 * 1024);
  fs.closeSync(fd);
  const pick = (re) => (text.match(re) || [])[1]?.trim() || null;
  return {
    grams: Number(pick(/; total filament used \[g\] = ([\d.]+)/)) || null,
    time: pick(/; estimated printing time \(normal mode\) = (.+)/),
    layers: Number(pick(/; total layer(?:s count| number)\s*[:=]\s*(\d+)/)) || null,
    material: pick(/; filament_type = (.+)/),
    color: pick(/; filament_colour = (.+)/),
    bedType: pick(/; curr_bed_type = (.+)/),
    bedTemp: Number(pick(/; first_layer_bed_temperature = (\d+)/)) || 0,
    nozzleTemp: Number(pick(/; first_layer_temperature = (\d+)/)) || 0,
  };
}

// Anycubic Slicer Next writes a "; paint_info" line that the Kobra X reads to
// report a file's colors; Orca doesn't, so add an equivalent one.
function injectPaintInfo(file, stats) {
  const info = [{
    paint_index: 0,
    paint_color: rgbFromHex(stats.color),
    material_type: String(stats.material || 'PLA').split(';')[0],
    filament_used: stats.grams || 0,
  }];
  const line = `; paint_info = ${JSON.stringify(info)}\n`;
  const data = fs.readFileSync(file);
  const marker = data.indexOf('; HEADER_BLOCK_END');
  const at = marker >= 0 ? marker : 0;
  fs.writeFileSync(file, Buffer.concat([data.subarray(0, at), Buffer.from(line), data.subarray(at)]));
}

function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: ORCA_HOME, XDG_CONFIG_HOME: path.join(ORCA_HOME, '.config') };
    const child = spawn(bin, args, { cwd, env });
    let out = '';
    const keep = (c) => { out += c; if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
  });
}

// One slice at a time: Orca is CPU and memory hungry.
let queue = Promise.resolve();
let busy = 0;

async function slice(req) {
  const input = insideData(req.input);
  if (!fs.existsSync(input)) throw new Error('Model file not found');
  if (!MODEL_EXT.test(input)) throw new Error('Unsupported model type');
  const { vendor, machine } = req;
  if (!vendor || !machine) throw new Error('vendor and machine are required');

  const id = crypto.randomUUID();
  const dir = path.join(DATA_DIR, 'slices', id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const machineCfg = store.resolve(vendor, 'machine', machine);
    const processCfg = store.resolve(vendor, 'process', req.process);
    const filamentCfg = store.resolve(vendor, 'filament', req.filament);
    for (const [key, fn] of Object.entries(PROCESS_OVERRIDES)) {
      if (req.options && key in req.options) Object.assign(processCfg, fn(req.options[key]));
    }
    // Without an explicit plate the CLI uses Cool Plate and its (low) bed temps.
    const bedType = BED_TYPES.some((b) => b.value === req.bedType) ? req.bedType : store.defaultBedType(vendor, machine);
    processCfg.curr_bed_type = bedType;
    machineCfg.curr_bed_type = bedType;
    const write = (name, cfg) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(cfg)); return p; };
    const m = write('machine.json', machineCfg);
    const p = write('process.json', processCfg);
    const f = write('filament.json', filamentCfg);

    // Orca reads STEP only in its GUI, not the CLI, so mesh it to STL first.
    let model = input;
    if (/\.(step|stp)$/i.test(input)) {
      model = path.join(dir, path.basename(input).replace(/\.(step|stp)$/i, '.stl'));
      const conv = await run(STEP2STL_BIN, [input, model], dir);
      if (conv.code !== 0 || !fs.existsSync(model)) {
        const why = conv.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' · ');
        throw new Error(`Couldn't convert the STEP file: ${why || conv.signal || `exit ${conv.code}`}`);
      }
    }

    // --repetitions is rejected by Orca 2.4.2's CLI; listing the model N times
    // and arranging gives the same result.
    const copies = Math.max(1, Math.min(64, Math.round(Number(req.copies) || 1)));
    const args = [
      '--datadir', path.join(ORCA_HOME, 'data'),
      '--slice', '0',
      '--arrange', '1',
      ...(req.orient ? ['--orient', '1'] : []),
      '--load-settings', `${m};${p}`,
      '--load-filaments', f,
      '--outputdir', dir,
      ...Array(copies).fill(model),
    ];
    const t0 = Date.now();
    const { code, signal, out } = await run(ORCA_BIN, args, dir);
    if (model !== input) fs.rmSync(model, { force: true });
    const gcode = fs.readdirSync(dir).filter((n) => n.endsWith('.gcode')).sort()[0];
    if (!gcode) {
      const reason = out.split('\n').map((l) => l.trim()).filter((l) => /error|invalid|not in range|fail|outside|collid|empty|unknown file|can not be parsed/i.test(l)).slice(-4).join(' · ');
      throw new Error(`Slicing failed (${signal || `exit ${code}`})${reason ? `: ${reason}` : ''}`);
    }
    const file = path.join(dir, gcode);
    const stats = gcodeStats(file);
    if (req.paintInfo) injectPaintInfo(file, stats);
    return { id, output: file, seconds: Math.round((Date.now() - t0) / 1000), copies, stats };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, version, busy });
    if (url.pathname === '/profiles') {
      const vendor = url.searchParams.get('vendor');
      const machine = url.searchParams.get('machine');
      store.resolve(vendor, 'machine', machine); // throws if unknown
      const processes = store.compatible(vendor, 'process', machine);
      const filaments = store.compatible(vendor, 'filament', machine);
      return json(res, 200, {
        machine,
        processes,
        filaments,
        bedTypes: BED_TYPES,
        defaults: {
          bedType: store.defaultBedType(vendor, machine),
          process: processes.find((n) => /^0\.20mm Standard/.test(n)) || processes[0] || null,
          filament: filaments.find((n) => /\bPLA\b/.test(n) && !/silk|matte|glow|high speed|hs|\+|cf|galaxy|metal|sparkle|luminous|color change/i.test(n)) || filaments[0] || null,
        },
      });
    }
    if (url.pathname === '/slice' && req.method === 'POST') {
      const body = await readJson(req);
      busy++;
      const job = queue.then(() => slice(body));
      queue = job.catch(() => {});
      try { return json(res, 200, await job); } finally { busy--; }
    }
    if (url.pathname === '/cleanup' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('bad id');
      fs.rmSync(path.join(DATA_DIR, 'slices', id), { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

fs.mkdirSync(path.join(ORCA_HOME, 'data'), { recursive: true });
if (require.main === module) {
  server.listen(PORT, () => console.log(`Slicer service (OrcaSlicer ${version}) on :${PORT}`));
}

module.exports = { slice, store };
