// Job log outcomes: why a job ended, and prints the printer only interrupted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobLog, planFilamentUse } = require('../lib/jobs');
const { SpoolStore } = require('../lib/spools');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const log = new JobLog(dir);
  const see = (status, progress, { file = 'oval.gcode', elapsed = progress * 180, error = null } = {}) => log.observe({
    id: 'k', name: 'Kobra X', online: true, status, error,
    job: ['printing', 'paused', 'completed'].includes(status) ? { file, progress, elapsed } : null,
  });
  return { log, see, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a brief error mid-print stays one job, which completes', () => {
  const { log, see, done } = setup();
  try {
    see('printing', 10);
    see('printing', 43);
    see('error', 43, { error: 'Printer reported an error' });
    assert.equal(log.list()[0].outcome, 'failed');
    assert.match(log.list()[0].endReason, /Printer reported an error \(at 43%\)/);
    see('printing', 44); // it carried on
    assert.equal(log.list().length, 1, 'no second job');
    assert.equal(log.list()[0].outcome, 'printing');
    assert.equal(log.list()[0].endReason, undefined);
    see('printing', 99);
    see('completed', 100);
    assert.equal(log.list().length, 1);
    assert.equal(log.list()[0].outcome, 'completed');
  } finally { done(); }
});

test('a brief idle mid-print is the same print too', () => {
  const { log, see, done } = setup();
  try {
    see('printing', 60);
    see('idle', 60);
    assert.equal(log.list()[0].outcome, 'cancelled');
    assert.match(log.list()[0].endReason, /idle without reporting a finish \(at 60%\)/);
    see('printing', 61);
    assert.equal(log.list().length, 1);
    assert.equal(log.list()[0].outcome, 'printing');
  } finally { done(); }
});

test('a real failure followed by a re-print from the start is two jobs', () => {
  const { log, see, done } = setup();
  try {
    see('printing', 40);
    see('error', 40, { error: 'Nozzle clog' });
    see('printing', 1, { elapsed: 60 });
    assert.equal(log.list().length, 2);
    const failed = log.list().find((j) => j.outcome === 'failed');
    assert.match(failed.endReason, /Nozzle clog \(at 40%\)/, 'the printer’s own message is kept');
  } finally { done(); }
});

test('a different file, or a long gap, does not reopen', () => {
  const { log, see, done } = setup();
  try {
    see('printing', 40);
    see('idle', 40);
    see('printing', 41, { file: 'other.gcode' });
    assert.equal(log.list().length, 2);
    see('idle', 41);
    const old = log.list().find((j) => j.file === 'other.gcode');
    old.endedAt = Date.now() - 31 * 60 * 1000;
    see('printing', 42, { file: 'other.gcode' });
    assert.equal(log.list().filter((j) => j.file === 'other.gcode').length, 2);
  } finally { done(); }
});

test('going idle at 99% counts as finished, and has no reason to show', () => {
  const { log, see, done } = setup();
  try {
    see('printing', 99);
    see('idle', 99);
    assert.equal(log.list()[0].outcome, 'completed');
    assert.equal(log.list()[0].endReason, undefined);
  } finally { done(); }
});

test('correcting an outcome by hand clears the reason', () => {
  const { log, see, done } = setup();
  try {
    see('printing', 50);
    see('error', 50);
    const j = log.list()[0];
    log.edit(j.id, { outcome: 'completed' });
    assert.equal(log.list()[0].outcome, 'completed');
    assert.equal(log.list()[0].endReason, undefined);
  } finally { done(); }
});

test('a file with no per-color weights charges its total to the slot it printed from', () => {
  // What a Kobra X reports for a hub-sliced file: one color, 0 g. The library knows the total.
  const plan = planFilamentUse([{ slot: 3, grams: 0 }], 81, true);
  assert.deepEqual(plan, [{ slot: 3, grams: 81 }]);

  const { log, see, done } = setup();
  try {
    const spools = new SpoolStore(log.dir, log);
    const roll = spools.install({ printerId: 'k', slot: 3, remainingGrams: 600 });
    see('printing', 50, { elapsed: 0 });
    log.setFilamentPlan(log.list()[0].id, plan);
    see('completed', 100, { elapsed: 0 });
    const after = spools.list().find((s) => s.id === roll.id);
    assert.equal(after.usedGrams, 81);
    assert.equal(after.remainingGrams, 519);
  } finally { done(); }
});

test('filament plans: known weights win, and an unknown split stays unassigned', () => {
  assert.deepEqual(planFilamentUse([{ slot: 0, grams: 5 }, { slot: 2, grams: 1 }], 99, true), [{ slot: 0, grams: 5 }, { slot: 2, grams: 1 }]);
  // Two colors on one slot are still one slot.
  assert.deepEqual(planFilamentUse([{ slot: 1, grams: 0 }, { slot: 1, grams: 0 }], 40, true), [{ slot: 1, grams: 40 }]);
  assert.deepEqual(planFilamentUse([{ slot: 0, grams: 0 }, { slot: 1, grams: 0 }], 40, true), [{ slot: null, grams: 40 }]);
  assert.deepEqual(planFilamentUse(null, 40, true), [{ slot: null, grams: 40 }]);
  assert.deepEqual(planFilamentUse(null, 40, false), [{ slot: 0, grams: 40 }]);
  assert.equal(planFilamentUse([{ slot: 1, grams: 0 }], 0, true), null);
});

test('a roll counts down while a print runs', () => {
  const { log, see, done } = setup();
  try {
    const spools = new SpoolStore(log.dir, log);
    const roll = spools.install({ printerId: 'k', slot: 3, remainingGrams: 600 });
    const left = () => spools.list().find((s) => s.id === roll.id);
    let told = 0;
    log.on('progress', () => { told += 1; });
    see('printing', 0, { elapsed: 0 });
    log.setFilamentPlan(log.list()[0].id, [{ slot: 3, grams: 80 }]);
    assert.equal(left().remainingGrams, 600);
    see('printing', 25, { elapsed: 0 });
    assert.equal(left().usedGrams, 20);
    assert.equal(left().liveGrams, 20);
    assert.equal(left().remainingGrams, 580);
    see('printing', 25.4, { elapsed: 0 });
    assert.equal(told, 1, 'only whole percents are announced');
    see('completed', 100, { elapsed: 0 });
    assert.equal(left().remainingGrams, 520);
    assert.equal(left().liveGrams, 0);
  } finally { done(); }
});

test('a cancelled print keeps what it used, on the right roll only', () => {
  const { log, see, done } = setup();
  try {
    const spools = new SpoolStore(log.dir, log);
    const mine = spools.install({ printerId: 'k', slot: 3, remainingGrams: 600 });
    const other = spools.install({ printerId: 'k', slot: 0, remainingGrams: 600 });
    see('printing', 0, { elapsed: 0 });
    log.setFilamentPlan(log.list()[0].id, [{ slot: 3, grams: 80 }]);
    see('printing', 50, { elapsed: 0 });
    see('idle', 50);
    const view = (r) => spools.list().find((s) => s.id === r.id);
    assert.equal(view(mine).remainingGrams, 560);
    assert.equal(view(other).remainingGrams, 600);
  } finally { done(); }
});

test('Adjust during a print only counts what it uses afterwards', () => {
  const { log, see, done } = setup();
  try {
    const spools = new SpoolStore(log.dir, log);
    const roll = spools.install({ printerId: 'k', slot: 3, remainingGrams: 600 });
    const left = () => spools.list().find((s) => s.id === roll.id).remainingGrams;
    see('printing', 0, { elapsed: 0 });
    log.setFilamentPlan(log.list()[0].id, [{ slot: 3, grams: 80 }]);
    see('printing', 50, { elapsed: 0 });
    spools.adjust(roll.id, 500);
    assert.equal(left(), 500, 'the weight typed in is what shows');
    see('printing', 75, { elapsed: 0 });
    assert.equal(left(), 480);
    spools.adjust(roll.id, 470);
    assert.equal(left(), 470, 'adjusting twice in one print');
    see('completed', 100, { elapsed: 0 });
    assert.equal(left(), 450);
    assert.equal(new SpoolStore(log.dir, log).list().find((s) => s.id === roll.id).remainingGrams, 450, 'after a restart too');
  } finally { done(); }
});

test('a print that started on the old roll is not charged to the new one', () => {
  const { log, see, done } = setup();
  try {
    const spools = new SpoolStore(log.dir, log);
    see('printing', 0, { elapsed: 600 });
    log.setFilamentPlan(log.list()[0].id, [{ slot: 3, grams: 80 }]);
    const roll = spools.install({ printerId: 'k', slot: 3, remainingGrams: 1000 });
    see('printing', 50, { elapsed: 600 });
    assert.equal(spools.list().find((s) => s.id === roll.id).remainingGrams, 1000);
  } finally { done(); }
});
