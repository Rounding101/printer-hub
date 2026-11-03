// Draws a preview for a G-code file that has none, from its toolpaths. In a
// worker, as a big file would otherwise hold up the whole hub.
const fs = require('node:fs');
const { workerData, parentPort } = require('node:worker_threads');
const { parseToolpath, render, png } = require('../slicer/thumbnail');

const img = render(parseToolpath(fs.readFileSync(workerData.file, 'latin1')), 300, 300);
if (img) fs.writeFileSync(workerData.out, png(300, 300, img));
parentPort.postMessage(!!img);
