import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Forwarder, PEER_TIMEOUT_MS, Peers, sortSessions } from '../relay/peers.mjs';

const session = (id, extra = {}) => ({
  id,
  state: 'working',
  needsYou: false,
  since: '2026-10-31T10:00:00.000Z',
  lastEvent: '2026-10-31T10:00:00.000Z',
  ...extra,
});

test('peer sessions merge with the host filled in and characters stripped', () => {
  const peers = new Peers();
  assert.equal(peers.accept({ host: 'mac', sessions: [session('a', { character: { id: 'fox' } })] }, 0), true);
  const [s] = peers.sessions();
  assert.equal(s.host, 'mac');
  assert.equal(s.character, undefined);
});

test('an unchanged heartbeat is not a change', () => {
  const peers = new Peers();
  peers.accept({ host: 'mac', sessions: [session('a')] }, 0);
  assert.equal(peers.accept({ host: 'mac', sessions: [session('a')] }, 15000), false);
  assert.equal(peers.accept({ host: 'mac', sessions: [session('a', { state: 'waiting' })] }, 16000), true);
});

test('a peer is dropped after the timeout', () => {
  const peers = new Peers();
  peers.accept({ host: 'mac', sessions: [session('a')] }, 0);
  assert.equal(peers.sweep(PEER_TIMEOUT_MS), false);
  assert.equal(peers.sweep(PEER_TIMEOUT_MS + 1), true);
  assert.deepEqual(peers.sessions(), []);
});

test('a bad body is rejected', () => {
  const peers = new Peers();
  assert.throws(() => peers.accept({ sessions: [] }));
  assert.throws(() => peers.accept({ host: 'mac' }));
});

test('merged sessions sort needs-you first, then working by latest event', () => {
  const sorted = sortSessions([
    session('old', { lastEvent: '2026-10-31T09:00:00.000Z' }),
    session('wait', { state: 'waiting' }),
    session('ask', { state: 'asking', needsYou: true }),
    session('new', { lastEvent: '2026-10-31T11:00:00.000Z' }),
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ['ask', 'new', 'old', 'wait']);
});

test('the forwarder posts its host and sessions and coalesces overlapping sends', async () => {
  const posts = [];
  let release;
  const fetchImpl = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    if (posts.length === 1) await new Promise((r) => (release = r));
    return { ok: true };
  };
  const f = new Forwarder({ url: 'http://pc:8790/', host: 'mac', snapshot: () => ({ sessions: [session('a')] }), fetchImpl });
  const first = f.send();
  f.send();
  f.send();
  release();
  await first;
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 2);
  assert.equal(posts[0].url, 'http://pc:8790/peer');
  assert.equal(posts[0].body.host, 'mac');
  assert.equal(f.ok, true);
});
