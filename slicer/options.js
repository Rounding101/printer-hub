// Settings the hub's slice dialog may override on the process preset. Only these
// reach OrcaSlicer, and a blank value keeps what the preset says.
const number = (key, min, max) => (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? { [key]: String(Math.max(min, Math.min(max, n))) } : {};
};
const oneOf = (key, allowed) => (v) => (allowed.includes(v) ? { [key]: v } : {});

const PROCESS_OVERRIDES = {
  infill: (v) => ({ sparse_infill_density: `${Math.max(0, Math.min(100, Number(v) || 0))}%` }),
  supports: (v) => (v === 'off' || !v
    ? { enable_support: '0' }
    : { enable_support: '1', support_type: v === 'tree' ? 'tree(auto)' : 'normal(auto)' }),
  brim: (v) => ({ brim_type: v ? 'auto_brim' : 'no_brim' }),
  walls: (v) => ({ wall_loops: String(Math.max(1, Math.min(10, Number(v) || 2))) }),
  infillPattern: oneOf('sparse_infill_pattern', ['grid', 'gyroid', 'cubic', 'adaptivecubic', 'honeycomb', 'triangles', 'lightning', 'rectilinear']),
  topLayers: number('top_shell_layers', 0, 30),
  bottomLayers: number('bottom_shell_layers', 0, 30),
  seam: oneOf('seam_position', ['nearest', 'aligned', 'back', 'random']),
  ironing: oneOf('ironing_type', ['no ironing', 'top', 'topmost', 'solid']),
  fuzzySkin: oneOf('fuzzy_skin', ['none', 'external', 'allwalls']),
  supportAngle: number('support_threshold_angle', 0, 90),
  supportBuildPlateOnly: (v) => ({ support_on_build_plate_only: v ? '1' : '0' }),
  brimWidth: number('brim_width', 1, 30),
  skirtLoops: number('skirt_loops', 0, 10),
  // Last, as it needs these others set a certain way or Orca refuses to slice.
  vase: (v) => (v ? {
    spiral_mode: '1',
    wall_loops: '1',
    top_shell_layers: '0',
    sparse_infill_density: '0%',
    enable_support: '0',
    ironing_type: 'no ironing',
  } : {}),
};

function applyOptions(processCfg, options = {}) {
  for (const [key, fn] of Object.entries(PROCESS_OVERRIDES)) {
    if (key in options && options[key] !== '' && options[key] != null) Object.assign(processCfg, fn(options[key]));
  }
  return processCfg;
}

module.exports = { applyOptions };
