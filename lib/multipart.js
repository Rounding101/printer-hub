// Minimal multipart/form-data POST over node:http (no fetch: printers want
// exact headers like Expect: 100-continue that fetch won't send).
const http = require('node:http');
const crypto = require('node:crypto');

function build(fields, file) {
  const boundary = '------------------------' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name.replace(/"/g, '')}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// POST url with { fields, file: {field, name, data} }. Resolves with parsed JSON.
function postMultipart(url, { fields = {}, file, headers = {}, expectContinue = false, timeoutMs = 300000 }) {
  const { body, contentType } = build(fields, file);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': contentType,
        'Content-Length': body.length,
        ...(expectContinue ? { Expect: '100-continue' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Upload failed: HTTP ${res.statusCode} ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`Upload reply was not JSON: ${text.slice(0, 200)}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Upload timed out')));
    req.on('error', reject);
    if (expectContinue) {
      // Send the body when the server says continue, or after 1s like curl does.
      let sent = false;
      const send = () => { if (!sent) { sent = true; req.end(body); } };
      req.on('continue', send);
      setTimeout(send, 1000);
      req.flushHeaders();
    } else {
      req.end(body);
    }
  });
}

module.exports = { postMultipart };
