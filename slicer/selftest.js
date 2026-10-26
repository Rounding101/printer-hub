// Build-time check: slice a 20 mm cube for each supported printer so a broken
// image fails `docker build` instead of the first real slice.
// Run with DATA_DIR pointing at a scratch directory.
const fs = require('node:fs');
const path = require('node:path');
const { slice } = require('./server');

const TARGETS = [
  { vendor: 'Anycubic', machine: 'Anycubic Kobra X 0.4 nozzle', paintInfo: true },
  { vendor: 'Flashforge', machine: 'Flashforge Adventurer 5M 0.4 Nozzle' },
];

function cubeStl(size = 20) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((c) => c * size));
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `solid cube\n${f.map((t) => ` facet normal 0 0 0\n  outer loop\n${t.map((i) => `   vertex ${v[i].join(' ')}\n`).join('')}  endloop\n endfacet\n`).join('')}endsolid cube\n`;
}

(async () => {
  const dataDir = path.resolve(process.env.DATA_DIR);
  const input = path.join(dataDir, 'selftest', 'cube.stl');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, cubeStl());
  const { store } = require('./server');
  for (const t of TARGETS) {
    const process_ = store.compatible(t.vendor, 'process', t.machine).find((n) => /^0\.20mm Standard/.test(n));
    const filament = store.compatible(t.vendor, 'filament', t.machine).find((n) => /\bPLA\b/.test(n));
    const r = await slice({ input, ...t, process: process_, filament, copies: 2 });
    if (!(r.stats.grams > 0) || !r.stats.layers) throw new Error(`${t.machine}: sliced file has no stats`);
    // PLA on the default plate should heat the bed properly (a Cool Plate
    // fallback gave 35 °C on the Kobra X).
    if (!(r.stats.bedTemp >= 45)) throw new Error(`${t.machine}: bed only ${r.stats.bedTemp} °C on ${r.stats.bedType}`);
    console.log(`selftest ok: ${t.machine} -> ${r.stats.layers} layers, ${r.stats.grams} g, ${r.stats.time}, bed ${r.stats.bedTemp} °C (${r.stats.bedType})`);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((err) => { console.error('selftest FAILED:', err.message); process.exit(1); });
