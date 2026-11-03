// Colors in sliced files and slicer projects.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { usedColors, projectFilamentPresets } = require('../slicer/colors');
const { projectFixture, FILAMENTS, zip } = require('../slicer/project-fixture');
const { projectFilaments } = require('../lib/library');
const { planFilamentUse } = require('../lib/jobs');

test('only the filaments a print uses are reported, with their place in the project', () => {
  assert.deepEqual(usedColors({ color: '#212721;#F1F0ED;#EF60A3;#9EA6B4', material: 'PLA;PLA;PETG;PLA', gramsPerFilament: '0.00, 43.63, 1.92, 0.00', grams: 45.55 }), [
    { index: 1, color: '#F1F0ED', material: 'PLA', grams: 43.63 },
    { index: 2, color: '#EF60A3', material: 'PETG', grams: 1.92 },
  ]);
});

test('a file with no breakdown counts as its first filament', () => {
  assert.deepEqual(usedColors({ color: '#FF0000', material: 'PLA', grams: 12 }), [{ index: 0, color: '#FF0000', material: 'PLA', grams: 12 }]);
  assert.deepEqual(usedColors({ color: '#FF0000;#00FF00', material: 'PLA;PLA', gramsPerFilament: '0, 0', grams: 3 }), [{ index: 0, color: '#FF0000', material: 'PLA', grams: 3 }]);
});

test('a project filament uses the same material for this printer, or the one picked', () => {
  const compatible = ['Anycubic PLA @Anycubic Kobra X 0.4 nozzle', 'Anycubic PETG @Anycubic Kobra X 0.4 nozzle'];
  assert.deepEqual(projectFilamentPresets([
    { preset: 'Anycubic PETG @Anycubic Kobra X 0.25 nozzle', color: '#111111' },
    { preset: 'Somebody Silk @Other', color: '#222222' },
    { color: '#333333' },
  ], compatible, 'Anycubic PLA @Anycubic Kobra X 0.4 nozzle'), [
    { preset: 'Anycubic PETG @Anycubic Kobra X 0.4 nozzle', color: '#111111' },
    { preset: 'Anycubic PLA @Anycubic Kobra X 0.4 nozzle', color: '#222222' },
    { preset: 'Anycubic PLA @Anycubic Kobra X 0.4 nozzle', color: '#333333' },
  ]);
});

test('project filaments are read from a .3mf, and anything else has none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colors-'));
  try {
    const project = path.join(dir, 'project.3mf');
    fs.writeFileSync(project, projectFixture());
    assert.deepEqual(projectFilaments(project), FILAMENTS);
    const plain = path.join(dir, 'plain.3mf');
    fs.writeFileSync(plain, zip({ '3D/3dmodel.model': '<model/>' }));
    assert.deepEqual(projectFilaments(plain), []);
    const broken = path.join(dir, 'broken.3mf');
    fs.writeFileSync(broken, zip({ 'Metadata/project_settings.config': 'not json' }));
    assert.deepEqual(projectFilaments(broken), []);
    const notZip = path.join(dir, 'junk.3mf');
    fs.writeFileSync(notZip, 'not a zip');
    assert.deepEqual(projectFilaments(notZip), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('each color used is charged to the slot chosen for it', () => {
  assert.deepEqual(planFilamentUse([{ slot: 3, grams: 43.63 }, { slot: 0, grams: 1.92 }], 45.55, true), [{ slot: 3, grams: 43.63 }, { slot: 0, grams: 1.92 }]);
});
