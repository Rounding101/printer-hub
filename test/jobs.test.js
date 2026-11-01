// Job log outcomes: why a job ended, and prints the printer only interrupted.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobLog } = require('../lib/jobs');

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
