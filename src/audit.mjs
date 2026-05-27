import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = process.env.AUDIT_LOG_FILE || '';
let stream;

function ensureStream() {
  if (!LOG_FILE) return null;
  if (stream) return stream;
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
  stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  stream.on('error', (e) => {
    console.error('[audit] stream error:', e.message);
    stream = null;
  });
  return stream;
}

export function audit(entry) {
  try {
    const s = ensureStream();
    if (!s) return;
    s.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
}
