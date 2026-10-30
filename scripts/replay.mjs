import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Board } from '../relay/state.mjs';
import { findOutcome, hasOutcome } from '../relay/transcript.mjs';

const file = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? join(import.meta.dirname, '..', 'spike', 'events.jsonl');
const withTranscripts = process.argv.includes('--transcripts');
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const board = new Board();
const last = new Map();
const time = (ms) => new Date(ms).toISOString().slice(11, 19);

function report(now, cause) {
  for (const s of board.snapshot(now).sessions) {
    const line = `${s.state}${s.detail ? ` (${s.detail})` : ''}${s.subagents ? ` +${s.subagents} sub` : ''}`;
    if (last.get(s.id) === line) continue;
    last.set(s.id, line);
    console.log(`${time(now)}  ${s.id.slice(0, 8)}  ${s.project.padEnd(12)} ${line.padEnd(70)} ← ${cause}`);
  }
}

const transcripts = new Map();
const transcriptLines = (path) => {
  if (!transcripts.has(path)) {
    try {
      transcripts.set(path, readFileSync(path, 'utf8').split('\n'));
    } catch {
      transcripts.set(path, []);
    }
  }
  return transcripts.get(path);
};

function tick(now) {
  board.sweep(now);
  if (!withTranscripts) return;
  for (const t of board.watchTargets(now)) {
    const outcome = findOutcome(transcriptLines(t.path), { ...t, until: now });
    if (hasOutcome(outcome)) board.resolve(t.sessionId, t.agentKey, outcome, now);
  }
}

let clock = null;
for (const { receivedAt, event } of lines) {
  const now = Date.parse(receivedAt);
  for (let t = (clock ?? now) + 2000; clock !== null && t < now; t += 2000) {
    tick(t);
    report(t, 'tick');
  }
  clock = now;
  board.apply(event, now);
  tick(now);
  report(now, `${event.hook_event_name}${event.tool_name ? ' ' + event.tool_name : ''}${event.agent_id ? ' [sub]' : ''}`);
}
