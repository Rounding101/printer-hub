// Filament rolls loaded in each printer slot, with remaining weight estimated
// from the job log: remaining = grams at the last set point - filament used by
// jobs on that slot since then, counting a running print by its progress.
// Nothing is decremented in place, so editing a job (e.g. fixing its outcome)
// automatically corrects the roll.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { filamentUsed } = require('./jobs');

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

  // What a job has taken from this roll's slot so far.
  jobGrams(job, spool) {
    const used = job.outcome === 'printing' ? filamentUsed(job) : job.filament || [];
    const grams = used.reduce((n, u) => (u.slot === spool.slot ? n + (u.grams || 0) : n), 0);
    // Adjusted during this print: what it had used by then is in the new weight.
    return Math.max(0, grams - (spool.adjustedDuring?.jobId === job.id ? spool.adjustedDuring.grams : 0));
  }

  usedSince(spool) {
    let grams = 0;
    for (const j of this.jobs.jobs) {
      if (j.printerId !== spool.printerId) continue;
      if (j.outcome !== 'printing' && (j.endedAt || 0) < spool.baseAt) continue; // finished before the roll was (re)set
      if (j.startedAt < spool.installedAt) continue; // started on the previous roll
      grams += this.jobGrams(j, spool);
    }
    return grams;
  }

  // The print running on this roll's printer, if it started on this roll.
  running(spool) {
    return this.jobs.openJob(spool.printerId)?.startedAt >= spool.installedAt ? this.jobs.openJob(spool.printerId) : null;
  }

  view(spool) {
    const used = this.usedSince(spool);
    const remaining = Math.max(0, spool.baseGrams - used);
    return {
      ...spool,
      usedGrams: Math.round(used * 10) / 10,
      liveGrams: this.running(spool) ? Math.round(this.jobGrams(this.running(spool), spool) * 10) / 10 : 0,
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
    const job = this.running(spool);
    // Counted before the weight changes, so an earlier adjust in this print is allowed for.
    const soFar = job ? filamentUsed(job).reduce((n, u) => (u.slot === spool.slot ? n + (u.grams || 0) : n), 0) : 0;
    spool.baseGrams = g;
    spool.baseAt = Date.now();
    if (job) spool.adjustedDuring = { jobId: job.id, grams: soFar };
    else delete spool.adjustedDuring;
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
