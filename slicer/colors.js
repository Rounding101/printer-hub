// Which filaments a sliced file really uses, from the lines Orca writes:
//   ; filament_colour = #212721;#F1F0ED;#EF60A3;#9EA6B4
//   ; filament_type = PLA;PLA;PLA;PLA
//   ; filament used [g] = 0.00, 43.63, 1.92, 0.00
// An index is the filament's place in the project, which is what the Kobra X
// reports back as paint_index.
function usedColors({ color, material, gramsPerFilament, grams }) {
  const colors = String(color || '').split(';').map((c) => c.trim());
  const types = String(material || '').split(';').map((t) => t.trim());
  const used = String(gramsPerFilament || '').split(/[,;]/).map(Number);
  const all = colors.map((c, index) => ({ index, color: c, material: types[index] || types[0] || 'PLA', grams: used[index] || 0 }));
  const some = all.filter((c) => c.grams > 0);
  if (some.length) return some;
  // No breakdown in the file: everything came from the first filament.
  return [{ index: 0, color: colors[0] || '', material: types[0] || 'PLA', grams: Number(grams) || 0 }];
}

// A filament file for each one in a project: the same material for this printer
// if it has it (projects name presets for their own nozzle), in the project's
// color. A material this printer lacks falls back to the one picked for the slice.
function projectFilamentPresets(project, compatible, chosen) {
  const base = (name) => String(name || '').replace(/ @.*$/, '');
  return project.map((p) => ({
    preset: compatible.find((n) => base(n) === base(p.preset)) || chosen,
    color: p.color || null,
  }));
}

module.exports = { usedColors, projectFilamentPresets };
