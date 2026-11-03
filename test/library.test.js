// Library organizing: renaming files, tags and folders.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Library, folderPath, cleanTags } = require('../lib/library');
const { JobLog } = require('../lib/jobs');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'));
  const lib = new Library(dir);
  const add = (name, extra) => lib.addFromStream(name, Readable.from([Buffer.from(`; ${name}\nG1 X1\n`)]), extra);
  return { dir, lib, add, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('renaming moves the file on disk and keeps its extension', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('rim.gcode');
    lib.update(a.id, { name: 'Oval rim' });
    assert.equal(lib.get(a.id).name, 'Oval rim.gcode');
    assert.ok(fs.existsSync(lib.filePath(lib.get(a.id))));
    assert.match(lib.read(a.id).toString(), /rim\.gcode/);
    lib.update(a.id, { name: 'Rim 2.GCODE' });
    assert.equal(lib.get(a.id).name, 'Rim 2.gcode');
    lib.update(a.id, { name: 'rim.stl' });
    assert.equal(lib.get(a.id).name, 'rim.stl.gcode', 'a typed extension can not change the type');
  } finally { done(); }
});

test('a renamed file still answers to its old name, and is sent again', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('rim.gcode');
    lib.markSent(a.id, 'kobra');
    lib.update(a.id, { name: 'oval' });
    assert.equal(lib.findByName('rim.gcode').id, a.id, 'a running print keeps its weight and preview');
    assert.equal(lib.findByName('oval.gcode').id, a.id);
    assert.deepEqual(lib.get(a.id).sentTo, [], 'the printer only has the old name');
    // A new file with the old name takes it over.
    const b = await add('rim.gcode');
    assert.equal(lib.findByName('rim.gcode').id, b.id);
  } finally { done(); }
});

test('bad renames are refused and change nothing', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('a.gcode');
    await add('b.gcode');
    assert.throws(() => lib.update(a.id, { name: 'B' }), /already has/);
    assert.throws(() => lib.update(a.id, { name: '' }), /Invalid/);
    assert.equal(lib.update(a.id, { name: '../../evil' }).name, 'evil.gcode', 'paths are dropped');
    assert.equal(path.dirname(lib.filePath(lib.get(a.id))), path.join(lib.dir, a.id));
    assert.equal(lib.update(a.id, { name: 'evil' }).previousNames.length, 1, 'same name is no rename');
  } finally { done(); }
});

test('a long name keeps its extension', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('a.gcode');
    assert.match(lib.update(a.id, { name: 'x'.repeat(300) }).name, /^x+\.gcode$/);
    assert.equal(lib.get(a.id).name.length, 200);
  } finally { done(); }
});

test('tags are cleaned and can be cleared', async () => {
  const { lib, add, done } = await setup();
  try {
    assert.deepEqual(cleanTags(' PLA, pla ,, gifts'), ['PLA', 'gifts']);
    assert.throws(() => cleanTags(Array.from({ length: 21 }, (_, i) => `t${i}`)), /20 tags/);
    const a = await add('a.gcode');
    assert.deepEqual(lib.update(a.id, { tags: ['Magnets', 'magnets', 'PETG'] }).tags, ['Magnets', 'PETG']);
    assert.equal(lib.update(a.id, { tags: [] }).tags, undefined);
  } finally { done(); }
});

test('folder paths are tidied, and never reach the disk', () => {
  assert.equal(folderPath(' Magnets / Oval/ '), 'Magnets/Oval');
  assert.equal(folderPath(''), '');
  assert.equal(folderPath(null), '');
  assert.throws(() => folderPath('a/../b'), /Invalid/);
  assert.throws(() => folderPath('1/2/3/4/5/6'), /5 levels/);
});

test('folders list their parents, and empty ones survive a restart', async () => {
  const { dir, lib, add, done } = await setup();
  try {
    await add('a.gcode', { folder: 'Magnets/Oval' });
    lib.addFolder('Gifts');
    assert.deepEqual(lib.folders(), ['Gifts', 'Magnets', 'Magnets/Oval']);
    assert.deepEqual(new Library(dir).folders(), ['Gifts', 'Magnets', 'Magnets/Oval']);
  } finally { done(); }
});

test('renaming a folder carries its files and subfolders', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('a.gcode', { folder: 'Magnets' });
    const b = await add('b.gcode', { folder: 'Magnets/Oval' });
    const c = await add('c.gcode', { folder: 'Magnets2' });
    lib.addFolder('Magnets/Empty');
    lib.renameFolder('Magnets', 'Parts/Mags');
    assert.equal(lib.get(a.id).folder, 'Parts/Mags');
    assert.equal(lib.get(b.id).folder, 'Parts/Mags/Oval');
    assert.equal(lib.get(c.id).folder, 'Magnets2', 'a similar name is another folder');
    assert.deepEqual(lib.folders(), ['Magnets2', 'Parts', 'Parts/Mags', 'Parts/Mags/Empty', 'Parts/Mags/Oval']);
    assert.throws(() => lib.renameFolder('Parts', 'Parts/Mags/Inner'), /inside itself/);
    assert.throws(() => lib.renameFolder('Nope', 'X'), /Unknown/);
    assert.throws(() => lib.renameFolder('Parts', 'a/b/c/d'), /5 levels/);
  } finally { done(); }
});

test('removing a folder keeps its files, a level up', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('a.gcode', { folder: 'A/B' });
    const b = await add('b.gcode', { folder: 'A/B/C' });
    const top = await add('c.gcode', { folder: 'Top' });
    lib.removeFolder('A/B');
    assert.equal(lib.get(a.id).folder, 'A');
    assert.equal(lib.get(b.id).folder, 'A/C');
    lib.removeFolder('Top');
    assert.equal(lib.get(top.id).folder, undefined);
    assert.ok(fs.existsSync(lib.filePath(lib.get(top.id))));
    assert.deepEqual(lib.folders(), ['A', 'A/C']);
  } finally { done(); }
});

test('deleting the last file leaves its folder', async () => {
  const { lib, add, done } = await setup();
  try {
    const a = await add('a.gcode', { folder: 'Magnets' });
    lib.remove(a.id);
    assert.deepEqual(lib.folders(), ['Magnets']);
  } finally { done(); }
});

test('a renamed file keeps its items per plate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-'));
  try {
    const log = new JobLog(dir);
    log.defaults['rim'] = 9;
    log.renamedFile('rim.gcode', 'oval rim.gcode');
    assert.equal(log.defaults['oval rim'], 9);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a re-slice with different content gets its own name', async () => {
  const { lib, done } = await setup();
  const sliced = (body) => lib.addFromStream('gear_ad5m_0.20mm_PLA.gcode', Readable.from([Buffer.from(body)]), {}, { newVersion: true });
  try {
    const one = await sliced('; first\nG1 X1\n');
    const two = await sliced('; second\nG1 X2\n');
    const three = await sliced('; third\nG1 X3\n');
    assert.equal(one.name, 'gear_ad5m_0.20mm_PLA.gcode');
    assert.equal(two.name, 'gear_ad5m_0.20mm_PLA_v2.gcode');
    assert.equal(three.name, 'gear_ad5m_0.20mm_PLA_v3.gcode');
    assert.ok(fs.existsSync(lib.filePath(two)), 'the file on disk has the new name');
    assert.match(lib.read(two.id).toString(), /second/);
    assert.equal((await sliced('; second\nG1 X2\n')).id, two.id, 'identical content is not stored twice');
    assert.equal(lib.list().length, 3);
  } finally { done(); }
});

test('a new version skips names in use, and old names of renamed files', async () => {
  const { lib, done } = await setup();
  const sliced = (body) => lib.addFromStream('gear.gcode', Readable.from([Buffer.from(body)]), {}, { newVersion: true });
  try {
    const one = await sliced('; one\n');
    lib.update(one.id, { name: 'my gear' });
    assert.equal((await sliced('; two\n')).name, 'gear_v2.gcode', 'a printer may still have the old gear.gcode');
    assert.equal(lib.freeName('x'.repeat(194) + '.gcode'), 'x'.repeat(194) + '.gcode');
    const long = 'y'.repeat(194) + '.gcode';
    await lib.addFromStream(long, Readable.from([Buffer.from('; long\n')]));
    const next = lib.freeName(long);
    assert.equal(next.length, 200);
    assert.match(next, /_v2\.gcode$/);
  } finally { done(); }
});

test('uploads with the same name are left as they are', async () => {
  const { lib, done } = await setup();
  try {
    await lib.addFromStream('a.gcode', Readable.from([Buffer.from('; one\n')]));
    const b = await lib.addFromStream('a.gcode', Readable.from([Buffer.from('; two\n')]));
    assert.equal(b.name, 'a.gcode');
  } finally { done(); }
});

const zlib = require('node:zlib');
const PNG_BYTES = Buffer.from('89504e470d0a1a0a00000000', 'hex');

// A minimal zip holding these files, the second one deflated.
function zipOf(files) {
  const locals = [];
  const dir = [];
  let offset = 0;
  for (const [name, data, deflate] of files) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    dir.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('G-code with no preview gets one drawn from its toolpaths', async () => {
  const { lib, done } = await setup();
  try {
    const moves = ';TYPE:Outer wall\nG1 Z0.2 F600\nG1 X0 Y0\nG1 X20 Y0 E1\nG1 X20 Y20 E2\nG1 X0 Y20 E3\nG1 X0 Y0 E4\n';
    const a = await lib.addFromStream('plain.gcode', Readable.from([Buffer.from(moves)]));
    assert.equal(a.thumb, false);
    const empty = await lib.addFromStream('empty.gcode', Readable.from([Buffer.from('; nothing\n')]));
    await lib.fillThumbs();
    assert.equal(lib.get(a.id).thumb, true);
    assert.equal(fs.readFileSync(lib.thumbPath(lib.get(a.id))).subarray(1, 4).toString(), 'PNG');
    assert.equal(lib.get(empty.id).thumb, false);
    assert.equal(lib.get(empty.id).thumbTried, true, 'not tried again');
    lib.update(a.id, { name: 'renamed' });
    assert.ok(fs.existsSync(lib.thumbPath(lib.get(a.id))), 'a rename keeps the picture');
  } finally { done(); }
});

test('a .3mf uses the picture inside it', async () => {
  const { lib, done } = await setup();
  try {
    const sliced = await lib.addFromStream('plate.3mf', Readable.from([zipOf([['Metadata/plate_1.gcode', Buffer.from('G1'), false], ['Metadata/plate_1.png', PNG_BYTES, true]])]));
    const model = await lib.addFromStream('project.3mf', Readable.from([zipOf([['3D/3dmodel.model', Buffer.from('<model/>'), false], ['Thumbnails/thumbnail.png', PNG_BYTES, false]])]));
    const none = await lib.addFromStream('bare.3mf', Readable.from([zipOf([['3D/3dmodel.model', Buffer.from('<x/>'), false]])]));
    const junk = await lib.addFromStream('junk.3mf', Readable.from([Buffer.from('not a zip at all')]));
    await lib.fillThumbs();
    assert.equal(sliced.kind, 'print');
    assert.equal(model.kind, 'model');
    assert.deepEqual(fs.readFileSync(lib.thumbPath(lib.get(sliced.id))), PNG_BYTES);
    assert.deepEqual(fs.readFileSync(lib.thumbPath(lib.get(model.id))), PNG_BYTES);
    assert.ok(!lib.get(none.id).thumb);
    assert.ok(!lib.get(junk.id).thumb);
  } finally { done(); }
});

test('a model takes a picture from the browser, PNG only', async () => {
  const { lib, done } = await setup();
  try {
    const m = await lib.addFromStream('part.stl', Readable.from([Buffer.from('solid x\nendsolid x\n')]));
    await lib.fillThumbs();
    assert.ok(!lib.get(m.id).thumbTried, 'the hub leaves STL to the browser');
    assert.throws(() => lib.setThumb(m.id, Buffer.from('<svg>')), /PNG/);
    lib.setThumb(m.id, PNG_BYTES);
    assert.equal(lib.get(m.id).thumb, true);
  } finally { done(); }
});
