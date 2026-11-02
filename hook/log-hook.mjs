import { appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.env.HANDLER_SPIKE_LOG ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'spike', 'events.jsonl');
const started = Date.now();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      event = { unparsed: raw };
    }
    const line = { receivedAt: new Date(started).toISOString(), host: hostname(), pid: process.ppid, event };
    appendFileSync(out, JSON.stringify(line) + '\n');
  } catch {}
  process.exit(0);
});
