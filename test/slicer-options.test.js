// Which slice settings reach OrcaSlicer, and in what form.
const test = require('node:test');
const assert = require('node:assert');
const { applyOptions } = require('../slicer/options');

test('blank settings keep the preset', () => {
  const preset = { sparse_infill_pattern: 'crosshatch', top_shell_layers: '5' };
  assert.deepEqual(applyOptions({ ...preset }, { infillPattern: '', topLayers: '', seam: null }), preset);
  assert.deepEqual(applyOptions({ ...preset }), preset);
  assert.deepEqual(applyOptions({ ...preset }, { unknownSetting: 'x', gcode_flavor: 'marlin' }), preset, 'only listed settings pass');
});

test('settings use the names and values Orca expects', () => {
  assert.deepEqual(applyOptions({}, {
    infillPattern: 'gyroid', topLayers: '6', bottomLayers: 4, seam: 'back', ironing: 'top', fuzzySkin: 'external',
    supportAngle: '45', supportBuildPlateOnly: true, brimWidth: '8', skirtLoops: 2,
  }), {
    sparse_infill_pattern: 'gyroid', top_shell_layers: '6', bottom_shell_layers: '4', seam_position: 'back', ironing_type: 'top', fuzzy_skin: 'external',
    support_threshold_angle: '45', support_on_build_plate_only: '1', brim_width: '8', skirt_loops: '2',
  });
  assert.equal(applyOptions({}, { supportBuildPlateOnly: false }).support_on_build_plate_only, '0');
  assert.equal(applyOptions({}, { topLayers: 0 }).top_shell_layers, '0', 'zero is a value, not blank');
});

test('out-of-range and unknown values are held back', () => {
  assert.deepEqual(applyOptions({}, { infillPattern: 'evil', seam: 'x', ironing: 'x', fuzzySkin: 'x', topLayers: 'lots' }), {});
  assert.equal(applyOptions({}, { topLayers: 999 }).top_shell_layers, '30');
  assert.equal(applyOptions({}, { supportAngle: -5 }).support_threshold_angle, '0');
  assert.equal(applyOptions({}, { brimWidth: 500 }).brim_width, '30');
});

test('vase mode overrides what it can not work with', () => {
  const cfg = applyOptions({}, { vase: true, infill: 40, walls: 4, supports: 'tree', topLayers: 5, ironing: 'top' });
  assert.equal(cfg.spiral_mode, '1');
  assert.equal(cfg.wall_loops, '1');
  assert.equal(cfg.top_shell_layers, '0');
  assert.equal(cfg.sparse_infill_density, '0%');
  assert.equal(cfg.enable_support, '0');
  assert.equal(cfg.ironing_type, 'no ironing');
  assert.equal(applyOptions({}, { vase: false }).spiral_mode, undefined);
});
