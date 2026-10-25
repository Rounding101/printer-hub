// Reads OrcaSlicer's bundled vendor profiles and resolves their "inherits"
// chains into complete, standalone presets the CLI can load directly.
const fs = require('node:fs');
const path = require('node:path');

class ProfileStore {
  constructor(profilesDir) {
    this.dir = profilesDir;
    this.byVendor = new Map(); // vendor -> { machine: Map, process: Map, filament: Map }
  }

  vendor(name) {
    if (this.byVendor.has(name)) return this.byVendor.get(name);
    const sets = { machine: new Map(), process: new Map(), filament: new Map() };
    for (const kind of Object.keys(sets)) {
      const dir = path.join(this.dir, name, kind);
      if (!fs.existsSync(dir)) continue;
      for (const f of walk(dir)) {
        try {
          const json = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (json.name) sets[kind].set(json.name, json);
        } catch { /* skip unreadable */ }
      }
    }
    // Generic parents (fdm_filament_pla etc.) live in the OrcaFilamentLibrary / BBL bundles too.
    this.byVendor.set(name, sets);
    return sets;
  }

  lookup(vendor, kind, name) {
    for (const v of [vendor, 'OrcaFilamentLibrary']) {
      const hit = this.vendor(v)[kind].get(name);
      if (hit) return hit;
    }
    return null;
  }

  // Merges parent -> child, dropping bookkeeping keys the CLI doesn't need.
  resolve(vendor, kind, name, seen = new Set()) {
    if (seen.has(name)) throw new Error(`Inheritance loop at ${name}`);
    seen.add(name);
    const own = this.lookup(vendor, kind, name);
    if (!own) throw new Error(`Orca ${kind} profile not found: ${name}`);
    const parent = own.inherits ? this.resolve(vendor, kind, own.inherits, seen) : {};
    const merged = { ...parent, ...own };
    delete merged.inherits;
    merged.name = own.name;
    // "system" makes the CLI use this name for compatible_printers checks;
    // a "User" preset would be looked up by its (now removed) inherits.
    merged.from = 'system';
    merged.instantiation = 'true';
    if (kind === 'machine') fixMachine(merged);
    return merged;
  }

  // Presets that list `machineName` in compatible_printers (or inherit a list that does).
  compatible(vendor, kind, machineName) {
    const out = [];
    for (const [name, json] of this.vendor(vendor)[kind]) {
      if (json.instantiation !== 'true') continue;
      let compat;
      try { compat = this.resolve(vendor, kind, name).compatible_printers; } catch { continue; }
      if (Array.isArray(compat) && compat.includes(machineName)) out.push(name);
    }
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
}

// The GUI tolerates some out-of-range values in vendor profiles that the CLI
// validates strictly. E.g. the Kobra X profile sets cut retraction to 0 while
// the feature is off; the CLI wants 10..18 regardless.
function fixMachine(m) {
  const off = (v) => v == null || v === '0' || (Array.isArray(v) && v.every((x) => x === '0'));
  if (off(m.enable_long_retraction_when_cut) && Array.isArray(m.retraction_distances_when_cut)) {
    m.retraction_distances_when_cut = m.retraction_distances_when_cut.map((v) => (Number(v) >= 10 && Number(v) <= 18 ? v : '18'));
  }
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.json')) yield p;
  }
}

module.exports = { ProfileStore };
