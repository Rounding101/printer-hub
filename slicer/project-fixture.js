// A small project .3mf in the form Bambu Studio and Anycubic Slicer Next save:
// four filaments and two cubes, the second cube in its own color. Orca treats
// these differently from a plain mesh, so the self-test needs one.
const fs = require('node:fs');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function zip(files) {
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const n = Buffer.from(name);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    dir.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function cube(id, size = 20) {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map((p) => p.map((c) => c * size));
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `<object id="${id}" type="model"><mesh><vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${t.map((f) => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('')}</triangles></mesh></object>`;
}

const COLORS = ['#212721', '#F1F0ED', '#EF60A3', '#9EA6B4'];
const FILAMENTS = COLORS.map((color, index) => ({ index, color, type: 'PLA', preset: 'Anycubic PLA @Anycubic Kobra X 0.25 nozzle' }));

// Orca's command line crashes on a project with only part of its settings, and
// real slicers save them all, so these come from the printer's own profiles.
function fullSettings(store) {
  const vendor = 'Anycubic';
  const machine = 'Anycubic Kobra X 0.4 nozzle';
  const preset = (kind, re) => store.resolve(vendor, kind, store.compatible(vendor, kind, machine).find((n) => re.test(n)));
  const filament = preset('filament', /\bPLA\b/);
  // Filament settings are per filament, so one value becomes four.
  const four = Object.fromEntries(Object.entries(filament).map(([k, v]) => [k, Array.isArray(v) && v.length === 1 ? COLORS.map(() => v[0]) : v]));
  return { ...store.resolve(vendor, 'machine', machine), ...preset('process', /^0\.20mm Standard/), ...four };
}

function projectFixture(store) {
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><metadata name="Application">BambuStudio-1.4.1.2</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources>${cube(1)}${cube(2)}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 60 60 0" printable="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 120 120 0" printable="1"/></build></model>`,
    'Metadata/model_settings.config': '<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="White"/><metadata key="extruder" value="2"/><part id="1" subtype="normal_part"><metadata key="name" value="White"/><metadata key="extruder" value="2"/></part></object><object id="2"><metadata key="name" value="Pink"/><metadata key="extruder" value="3"/><part id="2" subtype="normal_part"><metadata key="name" value="Pink"/><metadata key="extruder" value="3"/></part></object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/><model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="101"/></model_instance><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="102"/></model_instance></plate></config>',
    'Metadata/project_settings.config': JSON.stringify({
      ...(store ? fullSettings(store) : {}),
      from: 'project',
      version: '1.4.1.2',
      printer_model: 'Anycubic Kobra X',
      printer_settings_id: 'Anycubic Kobra X 0.25 nozzle',
      filament_colour: COLORS,
      filament_type: COLORS.map(() => 'PLA'),
      filament_settings_id: FILAMENTS.map((f) => f.preset),
    }),
  });
}

module.exports = { projectFixture, FILAMENTS, zip };

// node project-fixture.js <out.3mf>
if (require.main === module) fs.writeFileSync(process.argv[2], projectFixture(require('./server').store));
