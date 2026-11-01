import { hostname } from 'node:os';

if (process.env.TALLY_DISABLE === '1') process.exit(0);

const url = process.env.TALLY_URL ?? 'http://127.0.0.1:8790/events';

const trim = (value, max) => {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => trim(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, max)]));
  return value;
};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(raw);
    delete event.tool_response;
    delete event.permission_suggestions;
    if (event.tool_input) event.tool_input = trim(event.tool_input, event.tool_name === 'AskUserQuestion' ? 1000 : 300);
    if (event.last_assistant_message) event.last_assistant_message = trim(event.last_assistant_message, 4000);
    event.host = hostname();
    if (process.env.WARP_TERMINAL_SESSION_UUID) event.warp_session = process.env.WARP_TERMINAL_SESSION_UUID;
    event.ts = new Date().toISOString();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(500),
    });
  } catch {}
  process.exit(0);
});
