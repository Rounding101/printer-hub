// Preview images for printer screens. Orca's CLI writes no thumbnails (its
// renderer needs a GPU), so we draw one from the sliced G-code itself: every
// extrusion move, in a 3D view, shaded so walls and tops read as a solid
// object. Then embed it in the sizes and formats the printer profile asks for
// (PNG, or QOI for Prusa), in the standard "; thumbnail begin" comment blocks.
const fs = require('node:fs');
const zlib = require('node:zlib');

const AZIMUTH = (30 * Math.PI) / 180;   // look from the front, a little from the right
const ELEVATION = (32 * Math.PI) / 180; // and from above
const LIGHT = norm([-0.45, -0.6, 0.65]); // from front-left, above
const DEFAULT_SIZES = '32x32/PNG,300x300/PNG'; // Klipper UIs (Mainsail, Fluidd, KlipperScreen)

function norm(v) { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); }

// ---- G-code -> extrusion segments ------------------------------------------------

// Returns { segs: Float32Array [x0,y0,z0,x1,y1,z1,tool,flat]*, n, colors: [[r,g,b]] }.
// Skips start/end G-code (";TYPE:Custom"), travels and retractions.
function parseToolpath(text) {
  const out = [];
  let x = 0, y = 0, z = 0, e = 0, tool = 0, layer = 0;
  let absXYZ = true, absE = false, feature = null;
  const colors = ((/^; filament_colou?r = (.+)$/m.exec(text) || [])[1] || '')
    .split(/[;,]/).map((c) => hex(c.trim())).filter(Boolean);
  for (const raw of text.split('\n')) {
    if (raw.charCodeAt(0) === 59) { // ';'
      const t = /^;\s*(?:TYPE|FEATURE):\s*(.+)/.exec(raw);
      if (t) feature = t[1].trim().toLowerCase();
      else if (/^;\s*(LAYER_CHANGE|CHANGE_LAYER)/.test(raw)) layer++;
      continue;
    }
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const cmd = line.split(/\s+/, 1)[0].toUpperCase();
    if (cmd === 'G90') { absXYZ = true; continue; }
    if (cmd === 'G91') { absXYZ = false; continue; }
    if (cmd === 'M82') { absE = true; continue; }
    if (cmd === 'M83') { absE = false; continue; }
    if (cmd === 'G92') { const m = /E(-?[\d.]+)/i.exec(line); if (m) e = Number(m[1]); continue; }
    if (/^T\d+$/.test(cmd)) { tool = Number(cmd.slice(1)); continue; }
    if (!['G0', 'G1', 'G2', 'G3'].includes(cmd)) continue;
    let nx = x, ny = y, nz = z, de = 0;
    for (const m of line.matchAll(/([XYZE])(-?[\d.]+)/gi)) {
      const v = Number(m[2]);
      switch (m[1].toUpperCase()) {
        case 'X': nx = absXYZ ? v : x + v; break;
        case 'Y': ny = absXYZ ? v : y + v; break;
        case 'Z': nz = absXYZ ? v : z + v; break;
        case 'E': de = absE ? v - e : v; if (absE) e = v; break;
      }
    }
    if (de > 0 && feature && feature !== 'custom' && (nx !== x || ny !== y)) {
      // Surfaces, bridges and infill face up; walls face sideways.
      const flat = /surface|bridge|infill|ironing|skin/.test(feature) ? 1 : 0;
      out.push(x, y, z, nx, ny, nz, tool, flat + (layer % 2) * 2);
    }
    x = nx; y = ny; z = nz;
  }
  return { segs: Float32Array.from(out), n: out.length / 8, colors };
}

function hex(s) {
  const m = /^#?([0-9a-f]{6})/i.exec(s || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Very dark filament would vanish on a printer's dark screen; lift it a little.
function visible([r, g, b]) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum >= 70) return [r, g, b];
  const k = (70 - lum) / 255;
  return [r, g, b].map((c) => Math.round(c + (200 - c) * k));
}

// ---- Rendering ------------------------------------------------------------------

function project(x, y, z) {
  const ca = Math.cos(AZIMUTH), sa = Math.sin(AZIMUTH), ce = Math.cos(ELEVATION), se = Math.sin(ELEVATION);
  const rx = x * ca - y * sa;
  const ry = x * sa + y * ca;
  return [rx, z * ce + ry * se, ry * ce - z * se]; // screen x, screen up, depth (larger = farther)
}

// RGBA image of the toolpath fitted into w x h, transparent background.
function render(tp, w, h) {
  if (!tp.n) return null;
  const ss = Math.max(1, Math.min(4, Math.ceil(480 / Math.max(w, h)))); // supersampling
  const W = w * ss, H = h * ss;
  const pts = new Float32Array(tp.n * 6);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < tp.n; i++) {
    const s = tp.segs.subarray(i * 8, i * 8 + 6);
    const a = project(s[0], s[1], s[2]), b = project(s[3], s[4], s[5]);
    pts.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
    for (const p of [a, b]) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
  }
  const scale = Math.min((W * 0.9) / Math.max(maxX - minX, 1e-3), (H * 0.9) / Math.max(maxY - minY, 1e-3));
  const ox = W / 2 - ((minX + maxX) / 2) * scale, oy = H / 2 + ((minY + maxY) / 2) * scale;
  const r = Math.max(0.6, 0.25 * scale); // ~half an extrusion width, in pixels
  const ri = Math.ceil(r);

  const zbuf = new Float32Array(W * H).fill(Infinity);
  const rgb = new Uint8Array(W * H * 3);
  const cov = new Uint8Array(W * H);
  const palette = (tp.colors.length ? tp.colors : [[242, 117, 78]]).map(visible);
  const view = norm([Math.sin(AZIMUTH) * -1, -Math.cos(AZIMUTH), 0]); // toward the camera, horizontal

  for (let i = 0; i < tp.n; i++) {
    const s = tp.segs.subarray(i * 8, i * 8 + 8);
    const flags = s[7];
    // Normal: up for flat features, else the wall's outward side facing us.
    let n;
    if (flags & 1) n = [0, 0, 1];
    else {
      const dx = s[3] - s[0], dy = s[4] - s[1], l = Math.hypot(dx, dy) || 1;
      n = [dy / l, -dx / l, 0];
      if (n[0] * view[0] + n[1] * view[1] < 0) n = [-n[0], -n[1], 0];
    }
    let shade = 0.38 + 0.62 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    if (flags & 2) shade *= 0.93; // alternate layers, for a printed look
    const c = palette[Math.min(s[6], palette.length - 1)] || palette[0];
    const cr = Math.min(255, c[0] * shade), cg = Math.min(255, c[1] * shade), cb = Math.min(255, c[2] * shade);

    const p = pts.subarray(i * 6, i * 6 + 6);
    const x0 = ox + p[0] * scale, y0 = oy - p[1] * scale, x1 = ox + p[3] * scale, y1 = oy - p[4] * scale;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.7));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t, d = p[2] + (p[5] - p[2]) * t;
      const px = Math.round(cx), py = Math.round(cy);
      for (let yy = py - ri; yy <= py + ri; yy++) {
        if (yy < 0 || yy >= H) continue;
        for (let xx = px - ri; xx <= px + ri; xx++) {
          if (xx < 0 || xx >= W || (xx - cx) ** 2 + (yy - cy) ** 2 > r * r + 0.25) continue;
          const j = yy * W + xx;
          if (d >= zbuf[j]) continue;
          zbuf[j] = d;
          rgb[j * 3] = cr; rgb[j * 3 + 1] = cg; rgb[j * 3 + 2] = cb;
          cov[j] = 1;
        }
      }
    }
  }

  // Outline where depth jumps (rims, edges, one part in front of another),
  // like a CAD preview, so open tops and overlaps read clearly.
  let dMin = Infinity, dMax = -Infinity;
  for (let j = 0; j < W * H; j++) if (cov[j]) { if (zbuf[j] < dMin) dMin = zbuf[j]; if (zbuf[j] > dMax) dMax = zbuf[j]; }
  const jump = Math.max(1e-3, (dMax - dMin) * 0.04);
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const j = y * W + x;
      if (!cov[j]) continue;
      const near = [j + 1, j + W].some((k) => !cov[k] || Math.abs(zbuf[k] - zbuf[j]) > jump);
      if (near) { rgb[j * 3] *= 0.62; rgb[j * 3 + 1] *= 0.62; rgb[j * 3 + 2] *= 0.62; }
    }
  }

  // Downsample: average the covered subpixels; coverage becomes alpha.
  const img = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, R = 0, G = 0, B = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const j = (y * ss + sy) * W + x * ss + sx;
          if (!cov[j]) continue;
          n++; R += rgb[j * 3]; G += rgb[j * 3 + 1]; B += rgb[j * 3 + 2];
        }
      }
      if (!n) continue;
      const o = (y * w + x) * 4;
      img[o] = R / n; img[o + 1] = G / n; img[o + 2] = B / n; img[o + 3] = Math.round((255 * n) / (ss * ss));
    }
  }
  return img;
}

// ---- Encoders -------------------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// QOI (https://qoiformat.org), used by Prusa printers for their screens.
function qoi(w, h, rgba) {
  const out = [];
  const head = Buffer.alloc(14);
  head.write('qoif', 0); head.writeUInt32BE(w, 4); head.writeUInt32BE(h, 8); head[12] = 4; head[13] = 0;
  out.push(...head);
  const index = new Uint8Array(64 * 4);
  let pr = 0, pg = 0, pb = 0, pa = 255, run = 0;
  const total = w * h;
  for (let i = 0; i < total; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || i === total - 1) { out.push(0xc0 | (run - 1)); run = 0; }
      continue;
    }
    if (run) { out.push(0xc0 | (run - 1)); run = 0; }
    const h6 = ((r * 3 + g * 5 + b * 7 + a * 11) % 64) * 4;
    if (index[h6] === r && index[h6 + 1] === g && index[h6 + 2] === b && index[h6 + 3] === a) {
      out.push(h6 / 4);
    } else {
      index.set([r, g, b, a], h6);
      if (a === pa) {
        const dr = ((r - pr + 384) % 256) - 128, dg = ((g - pg + 384) % 256) - 128, db = ((b - pb + 384) % 256) - 128;
        const drg = dr - dg, dbg = db - dg;
        if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
        else if (dg >= -32 && dg <= 31 && drg >= -8 && drg <= 7 && dbg >= -8 && dbg <= 7) out.push(0x80 | (dg + 32), ((drg + 8) << 4) | (dbg + 8));
        else out.push(0xfe, r, g, b);
      } else {
        out.push(0xff, r, g, b, a);
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  out.push(0, 0, 0, 0, 0, 0, 0, 1);
  return Buffer.from(out);
}

// ---- Embedding ------------------------------------------------------------------

// "140x110", "230x110/PNG", "16x16/QOI", "320x320/COLPIC/#30394F" -> { w, h, fmt }
function thumbnailSpecs(machine) {
  let list = machine.thumbnails;
  if (Array.isArray(list)) list = list.join(',');
  list = String(list || '').trim() || DEFAULT_SIZES;
  const fallback = String(machine.thumbnails_format || 'PNG').toUpperCase();
  return list.split(/[,;]/).map((s) => {
    const m = /(\d+)\s*x\s*(\d+)(?:\/(\w+))?/i.exec(s);
    return m && { w: Number(m[1]), h: Number(m[2]), fmt: (m[3] || fallback).toUpperCase() };
  }).filter((s) => s && s.w >= 8 && s.h >= 8 && s.w <= 1024 && s.h <= 1024);
}

function block(spec, data) {
  const b64 = data.toString('base64');
  const tag = spec.fmt === 'PNG' ? 'thumbnail' : `thumbnail_${spec.fmt}`;
  const lines = [`; ${tag} begin ${spec.w}x${spec.h} ${b64.length}`];
  for (let i = 0; i < b64.length; i += 78) lines.push(`; ${b64.slice(i, i + 78)}`);
  lines.push(`; ${tag} end`, ';');
  return lines.join('\n');
}

// Adds thumbnails to a sliced G-code file. Returns the PNG for the hub's own
// use (the largest PNG made, or a 300x300 one), or null if there was nothing to draw.
function addThumbnails(file, machine) {
  const text = fs.readFileSync(file, 'latin1');
  if (/^; thumbnail(_\w+)? begin/m.test(text)) return null; // already has some
  const tp = parseToolpath(text);
  if (!tp.n) return null;
  const parts = [];
  let preview = null;
  const specs = thumbnailSpecs(machine);
  for (const spec of specs) {
    const img = render(tp, spec.w, spec.h);
    if (!img) continue;
    if (spec.fmt === 'PNG') {
      const data = png(spec.w, spec.h, img);
      if (!preview || spec.w * spec.h > preview.w * preview.h) preview = { w: spec.w, h: spec.h, data };
      parts.push(block(spec, data));
    } else if (spec.fmt === 'QOI') {
      parts.push(block(spec, qoi(spec.w, spec.h, img)));
    } // JPG and COLPIC (Elegoo) aren't produced; those printers also list a PNG size.
  }
  if (!parts.length) return null;
  const blockText = `;\n; THUMBNAIL_BLOCK_START\n;\n${parts.join('\n')}\n; THUMBNAIL_BLOCK_END\n;\n\n`;
  const at = text.indexOf('; HEADER_BLOCK_END');
  const pos = at >= 0 ? text.indexOf('\n', at) + 1 : 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from(text.slice(0, pos), 'latin1'), Buffer.from(blockText), Buffer.from(text.slice(pos), 'latin1')]));
  if (!preview || preview.w < 200) {
    const img = render(tp, 300, 300);
    preview = { w: 300, h: 300, data: png(300, 300, img) };
  }
  return preview;
}

module.exports = { addThumbnails, parseToolpath, render, png, qoi, thumbnailSpecs };
