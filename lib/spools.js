// Filament rolls loaded in each printer slot, with remaining weight estimated
// from the job log: remaining = grams at the last set point - filament used by
// jobs on that slot since then. Nothing is decremented in place, so editing a
// job (e.g. fixing its outcome) automatically corrects the roll.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class SpoolStore extends EventEmitter {
  constructor(dataDir, jobs) {
    super();
    this.file = path.join(dataDir, 'spools.json');
    this.jobs = jobs;
    this.spools = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.spools, null, 1));
    fs.renameSync(tmp, this.file);
    this.emit('change');
  }

  // The roll currently in a slot (the most recently installed one).
  current(printerId, slot) {
    return this.spools
      .filter((s) => s.printerId === printerId && s.slot === slot && !s.removedAt)
      .sort((a, b) => b.installedAt - a.installedAt)[0] || null;
  }

  usedSince(spool) {
    let grams = 0;
    for (const j of this.jobs.jobs) {
      if (j.printerId !== spool.printerId || !Array.isArray(j.filament)) continue;
      if ((j.endedAt || 0) < spool.baseAt) continue; // finished before the roll was (re)set
      if (j.startedAt < spool.installedAt) continue; // started on the previous roll
      for (const u of j.filament) if (u.slot === spool.slot) grams += u.grams || 0;
    }
    return grams;
  }

  view(spool) {
    const used = this.usedSince(spool);
    const remaining = Math.max(0, spool.baseGrams - used);
    return {
      ...spool,
      usedGrams: Math.round(used * 10) / 10,
      remainingGrams: Math.round(remaining),
      percent: spool.capacityGrams ? Math.round((remaining / spool.capacityGrams) * 100) : null,
    };
  }

  list() {
    return this.spools.filter((s) => !s.removedAt).map((s) => this.view(s));
  }

  // A fresh (or part-used) roll goes into a slot, replacing whatever was there.
  install({ printerId, slot, capacityGrams = 1000, remainingGrams, material, color, brand, note }) {
    if (!printerId) throw new Error('printerId is required');
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 0 || s > 15) throw new Error('slot must be 0–15');
    const capacity = Math.max(50, Math.min(10000, Math.round(Number(capacityGrams) || 1000)));
    const start = remainingGrams == null || remainingGrams === '' ? capacity : Math.max(0, Math.min(capacity, Math.round(Number(remainingGrams))));
    const now = Date.now();
    const prev = this.current(printerId, s);
    if (prev) prev.removedAt = now;
    const spool = {
      id: crypto.randomUUID(), printerId, slot: s,
      capacityGrams: capacity, baseGrams: start, baseAt: now, installedAt: now,
      material: material ? String(material).slice(0, 40) : null,
      color: Array.isArray(color) ? color.slice(0, 3).map((c) => Math.max(0, Math.min(255, Number(c) || 0))) : null,
      brand: brand ? String(brand).slice(0, 40) : null,
      note: note ? String(note).slice(0, 200) : null,
    };
    this.spools.push(spool);
    this.save();
    return this.view(spool);
  }

  // Correct the estimate, e.g. after weighing the roll.
  adjust(id, remainingGrams) {
    const spool = this.spools.find((s) => s.id === id && !s.removedAt);
    if (!spool) throw new Error('Unknown roll');
    const g = Math.round(Number(remainingGrams));
    if (!Number.isFinite(g) || g < 0 || g > 10000) throw new Error('remaining must be 0–10000 g');
    spool.baseGrams = g;
    spool.baseAt = Date.now();
    this.save();
    return this.view(spool);
  }

  remove(id) {
    const spool = this.spools.find((s) => s.id === id && !s.removedAt);
    if (!spool) throw new Error('Unknown roll');
    spool.removedAt = Date.now();
    this.save();
  }
}

module.exports = { SpoolStore };
