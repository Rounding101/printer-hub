// Build-time check: slice a 20 mm cube for each supported printer so a broken
// image fails `docker build` instead of the first real slice.
// Run with DATA_DIR pointing at a scratch directory.
const fs = require('node:fs');
const path = require('node:path');
const { slice } = require('./server');
const { projectFixture, FILAMENTS } = require('./project-fixture');

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
    // The printer's screen preview, in the size its profile asks for.
    const want = { Anycubic: '230x110', Flashforge: '140x110' }[t.vendor];
    if (!new RegExp(`^; thumbnail begin ${want} \\d+$`, 'm').test(fs.readFileSync(r.output, 'latin1').slice(0, 200000))) {
      throw new Error(`${t.machine}: no ${want} preview image in the G-code`);
    }
    console.log(`selftest ok: ${t.machine} -> ${r.stats.layers} layers, ${r.stats.grams} g, ${r.stats.time}, bed ${r.stats.bedTemp} °C (${r.stats.bedType})`);
  }

  // Settings from the slice dialog reach the G-code.
  const opt = TARGETS[0];
  const base = {
    input, ...opt,
    process: store.compatible(opt.vendor, 'process', opt.machine).find((n) => /^0\.20mm Standard/.test(n)),
    filament: store.compatible(opt.vendor, 'filament', opt.machine).find((n) => /\bPLA\b/.test(n)),
  };
  const checks = [
    [{ infillPattern: 'gyroid', topLayers: 6, seam: 'back', ironing: 'top', fuzzySkin: 'external', skirtLoops: 2 },
      { sparse_infill_pattern: 'gyroid', top_shell_layers: '6', seam_position: 'back', ironing_type: 'top', fuzzy_skin: 'external', skirt_loops: '2' }],
    [{ vase: true, infill: 40, walls: 4 }, { spiral_mode: '1', wall_loops: '1', top_shell_layers: '0' }],
  ];
  for (const [options, want] of checks) {
    const g = fs.readFileSync((await slice({ ...base, options })).output, 'latin1');
    for (const [k, v] of Object.entries(want)) {
      if (!new RegExp(`^; ${k} = ${v}\\s*$`, 'm').test(g)) throw new Error(`${k} is not ${v} in the G-code`);
    }
  }
  console.log('selftest ok: slice settings reach the G-code');

  // A project .3mf keeps its filaments and colors, and the Kobra X is told each one used.
  const project = path.join(dataDir, 'selftest', 'project.3mf');
  fs.writeFileSync(project, projectFixture(store));
  const pr = await slice({ ...base, input: project, projectFilaments: FILAMENTS });
  const used = pr.stats.colors.map((c) => `${c.index}:${c.color}`).join(' ');
  if (used !== '1:#F1F0ED 2:#EF60A3') throw new Error(`project colors came through as ${used}`);
  const paint = /^; paint_info = (.*)$/m.exec(fs.readFileSync(pr.output, 'latin1'));
  if (!paint || JSON.parse(paint[1]).map((p) => p.paint_index).join() !== '1,2') throw new Error(`paint_info is ${paint && paint[1]}`);
  console.log(`selftest ok: project .3mf -> ${used}`);

  if (process.env.SKIP_STEP) { fs.rmSync(dataDir, { recursive: true, force: true }); return; }

  // STEP goes through the OpenCASCADE converter. The test part is 12 mm tall,
  // so ~60 layers at 0.2 mm proves the units came through as millimetres.
  const step = path.join(dataDir, 'selftest', 'part.step');
  fs.copyFileSync(process.env.STEP_TEST || '/opt/step2stl/test.step', step);
  const t = TARGETS[0];
  const r = await slice({
    input: step, ...t,
    process: store.compatible(t.vendor, 'process', t.machine).find((n) => /^0\.20mm Standard/.test(n)),
    filament: store.compatible(t.vendor, 'filament', t.machine).find((n) => /\bPLA\b/.test(n)),
  });
  if (!(r.stats.grams > 5) || !(r.stats.layers >= 55 && r.stats.layers <= 65)) {
    throw new Error(`STEP part sliced wrong: ${r.stats.layers} layers, ${r.stats.grams} g`);
  }
  console.log(`selftest ok: STEP part -> ${r.stats.layers} layers, ${r.stats.grams} g`);
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((err) => { console.error('selftest FAILED:', err.message); process.exit(1); });
