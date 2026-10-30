import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? join(import.meta.dirname, '..', 'spike', 'events.jsonl');
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const detail = (e) =>
  e.tool_name ??
  e.notification_type ??
  e.agent_type ??
  e.source ??
  e.reason ??
  (e.prompt ? JSON.stringify(e.prompt.slice(0, 50)) : '') ??
  '';

for (const { receivedAt, event: e } of lines) {
  const time = receivedAt.slice(11, 23);
  const session = (e.session_id ?? '').slice(0, 8);
  const project = (e.cwd ?? '').split(/[\\/]/).pop();
  console.log(`${time}  ${session}  ${project.padEnd(14)} ${(e.hook_event_name ?? '?').padEnd(18)} ${detail(e)}`);
}

if (process.argv.includes('--fields')) {
  const fields = {};
  for (const { event: e } of lines) {
    const name = e.hook_event_name ?? '?';
    fields[name] ??= new Set();
    Object.keys(e).forEach((k) => fields[name].add(k));
  }
  console.log();
  for (const [name, keys] of Object.entries(fields)) console.log(`${name}: ${[...keys].join(', ')}`);
}
