import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../relay/state.mjs';
import { readLive } from '../relay/live.mjs';

const inTemp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-live-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const entry = (sessionId, pid, extra = {}) => JSON.stringify({ pid, sessionId, cwd: '/p/app', kind: 'interactive', status: 'idle', ...extra });
const alive = (pid) => pid !== 999;
const live = (id, extra = {}) => ({ id, cwd: '/p/app', status: 'idle', host: 'mac', ...extra });

test('readLive keeps interactive sessions whose process is alive', () =>
  inTemp((dir) => {
    writeFileSync(join(dir, '1.json'), entry('open', 1));
    writeFileSync(join(dir, '2.json'), entry('dead', 999));
    writeFileSync(join(dir, '3.json'), entry('script', 3, { kind: 'print' }));
    writeFileSync(join(dir, '1.abc.key'), 'not json');
    assert.deepEqual(readLive(dir, { alive, host: 'mac' }).map((l) => [l.id, l.host]), [['open', 'mac']]);
  }));

test('readLive: a missing folder is no sessions, a half-written file skips the round', () =>
  inTemp((dir) => {
    assert.deepEqual(readLive(join(dir, 'nope'), { alive }), []);
    writeFileSync(join(dir, '1.json'), entry('open', 1));
    writeFileSync(join(dir, '2.json'), '{"pid":');
    assert.equal(readLive(dir, { alive }), null);
  }));

test('a live session gets a card before its first prompt', () => {
  const board = new Board();
  assert.equal(board.syncLive([live('a'), live('b', { status: 'busy' })], 1000), true);
  const states = Object.fromEntries(board.snapshot(1000).sessions.map((s) => [s.id, [s.state, s.project, s.host]]));
  assert.deepEqual(states, { a: ['waiting', 'app', 'mac'], b: ['working', 'app', 'mac'] });
  assert.equal(board.syncLive([live('a'), live('b', { status: 'busy' })], 2000), false);
});

test('a live session outlasts the idle expiry, and expires normally once it is not live', () => {
  const board = new Board();
  const later = 5 * 3600e3;
  board.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'x', cwd: '/p' }, 1000);
  board.apply({ session_id: 'a', hook_event_name: 'Stop', cwd: '/p' }, 2000);
  board.syncLive([live('a')], 3000);
  board.sweep(later);
  assert.equal(board.snapshot(later).sessions[0].summary, 'x');
  board.syncLive([], later);
  assert.equal(board.snapshot(later).sessions[0].state, 'ended');
  board.sweep(later + 2 * 60e3 + 1);
  assert.equal(board.sessions.size, 0);
});

test('a session that was never seen live keeps the old rules when the scan finds nothing', () => {
  const board = new Board();
  board.apply({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'x', cwd: '/p' }, 1000);
  board.syncLive([], 2000);
  assert.equal(board.snapshot(2000).sessions[0].state, 'working');
});

test('a failed scan changes nothing', () => {
  const board = new Board();
  board.syncLive([live('a')], 1000);
  assert.equal(board.syncLive(null, 2000), false);
  assert.equal(board.snapshot(2000).sessions[0].state, 'waiting');
});

test('idle corrects a stuck working card, but only after a quiet spell and never over a prompt', () => {
  const board = new Board();
  board.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: {}, cwd: '/p' }, 1000);
  board.syncLive([live('a')], 5000);
  assert.equal(board.snapshot(5000).sessions[0].state, 'working');
  board.syncLive([live('a')], 20000);
  assert.equal(board.snapshot(20000).sessions[0].state, 'waiting');

  board.apply({ session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u', tool_input: {}, cwd: '/p' }, 30000);
  board.apply({ session_id: 'a', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {}, cwd: '/p' }, 30001);
  board.syncLive([live('a')], 90000);
  assert.equal(board.snapshot(90000).sessions[0].state, 'needs_permission');
});

test('an ended session is not brought back by a lingering live entry', () => {
  const board = new Board();
  board.syncLive([live('a')], 1000);
  board.apply({ session_id: 'a', hook_event_name: 'SessionEnd', cwd: '/p/app' }, 2000);
  board.syncLive([live('a')], 3000);
  assert.equal(board.snapshot(3000).sessions[0].state, 'ended');
});

test('a restored session whose process died meanwhile is marked ended', () => {
  const board = new Board();
  board.syncLive([live('a')], 1000);
  const fresh = new Board();
  fresh.restore(JSON.parse(JSON.stringify(board.dump())), 2000);
  fresh.syncLive([], 3000);
  assert.equal(fresh.snapshot(3000).sessions[0].state, 'ended');
});
