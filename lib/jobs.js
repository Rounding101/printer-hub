// Print job log: watches normalized printer state and records each job from
// start to finish, persisted as JSON in data/. Each job carries a quantity
// (items per plate), defaulted from the last quantity used for the same model.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ACTIVE = ['printing', 'heating', 'pausing', 'paused', 'cancelling'];
const OUTCOMES = ['printing', 'completed', 'cancelled', 'failed', 'unknown'];

// "1024-1448-Shark Holder_plate(01)_PLA_0.2_3h0m44s.gcode" -> "Shark Holder"
// so re-slices of the same model group together.
function itemName(file) {
  let n = String(file || '').replace(/^.*[\\/]/, '');
  n = n.replace(/\.(gcode|gx|g|3mf|bgcode)$/i, '');
  n = n.replace(/^\d{4}-\d{4}-/, '');
  n = n.replace(/_(PLA|PETG|ABS|ASA|TPU|PA|PC|PVA|HIPS|PET|CF|SILK)[^_]*_\d+(\.\d+)?_[\dhms]+$/i, '');
  const plate = /_plate\((\d+)\)$/i.exec(n);
  n = n.replace(/_plate\(\d+\)$/i, '');
  if (plate && +plate[1] > 1) n += ` (plate ${+plate[1]})`;
  return n.replace(/_/g, ' ').trim() || String(file);
}
const itemKey = (file) => itemName(file).toLowerCase();

class JobLog extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'jobs.json');
    fs.mkdirSync(dir, { recursive: true });
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.jobs = saved.jobs || [];
    this.defaults = saved.defaults || {}; // itemKey -> items per plate
    this.lastStatus = new Map();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ jobs: this.jobs, defaults: this.defaults }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  changed(job) {
    this.save();
    this.emit('job', job);
  }

  openJob(printerId) {
    return this.jobs.find((j) => j.printerId === printerId && j.outcome === 'printing');
  }

  // Called on every printer state update.
  observe(state) {
    if (!state.online) return; // never close jobs on a connection blip
    const prev = this.lastStatus.get(state.id);
    this.lastStatus.set(state.id, state.status);
    let open = this.openJob(state.id);
    const job = state.job;

    if (ACTIVE.includes(state.status) && job?.file) {
      if (open && open.file !== job.file) {
        this.close(open, 'unknown');
        open = null;
      }
      if (!open) {
        const key = itemKey(job.file);
        open = {
          id: crypto.randomUUID(),
          printerId: state.id,
          printerName: state.name,
          file: job.file,
          item: itemName(job.file),
          quantity: this.defaults[key] ?? 1,
          quantitySet: key in this.defaults,
          outcome: 'printing',
          startedAt: Date.now() - (job.elapsed ? job.elapsed * 1000 : 0),
          endedAt: null,
          printSeconds: 0,
          progress: 0,
          notes: '',
        };
        this.jobs.push(open);
        this.changed(open);
      }
      const progress = job.progress || 0;
      const printSeconds = Math.max(open.printSeconds, job.elapsed || 0);
      if (progress !== open.progress || printSeconds !== open.printSeconds) {
        open.progress = progress;
        open.printSeconds = printSeconds;
        open.lastSeen = Date.now();
        // Persist progress at most once a minute; final state is saved on close.
        if (!open.savedAt || Date.now() - open.savedAt > 60000) { open.savedAt = Date.now(); this.save(); }
      }
      return;
    }

    if (!open) return;
    if (state.status === 'completed') this.close(open, 'completed');
    else if (state.status === 'error') this.close(open, 'failed');
    else if (state.status === 'idle') {
      // Some printers go straight back to idle after finishing. If the hub was
      // restarted while this job was open, we can't tell what happened.
      const finished = open.progress >= 99.5 || (job && job.progress >= 99.5);
      this.close(open, finished ? 'completed' : prev === undefined ? 'unknown' : 'cancelled');
    }
  }

  close(job, outcome) {
    job.outcome = outcome;
    job.endedAt = Date.now();
    if (!job.printSeconds) job.printSeconds = Math.round((job.endedAt - job.startedAt) / 1000);
    if (outcome === 'completed') job.progress = 100;
    delete job.savedAt;
    this.changed(job);
  }

  list() {
    return [...this.jobs].sort((a, b) => b.startedAt - a.startedAt);
  }

  // Edits from the UI. Setting quantity also becomes the default for this
  // model, and fills in earlier jobs of it that were never given one.
  edit(id, patch) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error('Unknown job');
    if (patch.quantity != null) {
      const q = Math.max(0, Math.min(10000, Math.round(Number(patch.quantity)) || 0));
      job.quantity = q;
      job.quantitySet = true;
      this.setDefault(itemKey(job.file), q);
    }
    if (patch.outcome && OUTCOMES.includes(patch.outcome) && patch.outcome !== 'printing') {
      job.outcome = patch.outcome;
      job.endedAt = job.endedAt || Date.now();
    }
    if (patch.notes != null) job.notes = String(patch.notes).slice(0, 500);
    this.save();
    this.emit('reset');
    return job;
  }

  setDefault(key, q) {
    this.defaults[key] = q;
    for (const other of this.jobs) {
      if (!other.quantitySet && itemKey(other.file) === key) { other.quantity = q; other.quantitySet = true; }
    }
  }

  remove(id) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) throw new Error('Unknown job');
    this.jobs.splice(i, 1);
    this.save();
    this.emit('reset');
  }

  // Back-fill prints made before the hub was logging: `plates` completed jobs.
  addManual({ file, printerId, printerName, plates = 1, quantity, hours = 0, date }) {
    if (!file) throw new Error('Item name is required');
    const n = Math.max(1, Math.min(1000, Math.round(Number(plates)) || 1));
    const key = itemKey(file);
    const q = quantity != null && quantity !== '' ? Math.max(0, Math.round(Number(quantity)) || 0) : (this.defaults[key] ?? 1);
    if (quantity != null && quantity !== '') this.setDefault(key, q);
    const startedAt = date ? new Date(date).getTime() || Date.now() : Date.now();
    const secs = Math.round((Number(hours) || 0) * 3600);
    for (let i = 0; i < n; i++) {
      this.jobs.push({
        id: crypto.randomUUID(), printerId: printerId || null, printerName: printerName || 'Manual entry',
        file, item: itemName(file), quantity: q, quantitySet: true, outcome: 'completed',
        startedAt, endedAt: startedAt + secs * 1000, printSeconds: secs, progress: 100, notes: '', manual: true,
      });
    }
    this.save();
    this.emit('reset');
  }

  csv() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['started', 'ended', 'printer', 'item', 'file', 'outcome', 'items_per_plate', 'print_hours', 'manual', 'notes']];
    for (const j of this.list()) {
      rows.push([
        new Date(j.startedAt).toISOString(), j.endedAt ? new Date(j.endedAt).toISOString() : '',
        j.printerName, j.item, j.file, j.outcome, j.quantity, (j.printSeconds / 3600).toFixed(2), j.manual ? 'yes' : '', j.notes,
      ]);
    }
    return rows.map((r) => r.map(esc).join(',')).join('\r\n');
  }
}

module.exports = { JobLog, itemName, itemKey };
