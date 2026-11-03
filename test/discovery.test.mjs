import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastAddresses, isLocal, MAIN_TIMEOUT_MS, Mains, parseMessage } from '../relay/discovery.mjs';
import { Forwarder } from '../relay/peers.mjs';

const msg = (o) => Buffer.from(JSON.stringify({ magic: 'handler-relay', ...o }));

test('only well-formed messages are accepted', () => {
  assert.deepEqual(parseMessage(msg({ type: 'looking' })), { type: 'looking' });
  assert.deepEqual(parseMessage(msg({ type: 'here', host: 'PC', port: 8790 })), { type: 'here', host: 'PC', port: 8790 });
  assert.equal(parseMessage(msg({ type: 'here', host: 'PC', port: 80 })), null);
  assert.equal(parseMessage(msg({ type: 'here', host: '', port: 8790 })), null);
  assert.equal(parseMessage(msg({ type: 'here', host: 'x'.repeat(81), port: 8790 })), null);
  assert.equal(parseMessage(Buffer.from(JSON.stringify({ type: 'looking' }))), null);
  assert.equal(parseMessage(Buffer.from('nonsense')), null);
});

test('broadcast addresses come from each external IPv4 interface', () => {
  const found = broadcastAddresses({
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    en0: [
      { address: '192.168.4.20', netmask: '255.255.252.0', family: 'IPv4', internal: false },
      { address: 'fe80::1', netmask: 'ffff::', family: 'IPv6', internal: false },
    ],
    en1: [{ address: '10.1.2.3', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
  });
  assert.deepEqual(found, ['192.168.7.255', '10.1.2.255']);
});

test('public senders are not trusted', () => {
  assert.ok(isLocal('192.168.4.55'));
  assert.ok(isLocal('::ffff:10.0.0.1'));
  assert.ok(!isLocal('8.8.8.8'));
  assert.ok(!isLocal('172.32.0.1'));
});

test('mains ignore this computer, follow a new address and fall off when silent', () => {
  const mains = new Mains('me');
  assert.equal(mains.note({ host: 'me', port: 8790 }, '192.168.4.20', 0), null);
  mains.note({ host: 'PC', port: 8790 }, '192.168.4.55', 0);
  mains.note({ host: 'PC', port: 8790 }, '::ffff:192.168.4.60', 1000);
  assert.deepEqual(mains.list(1000).map((m) => [m.host, m.address]), [['PC', '192.168.4.60']]);
  assert.deepEqual(mains.list(1000 + MAIN_TIMEOUT_MS + 1), []);
});

test('a forwarder with no main yet sends nothing, then sends once pointed', async () => {
  const sent = [];
  const forwarder = new Forwarder({
    url: null,
    host: 'mac',
    snapshot: () => ({ sessions: [] }),
    fetchImpl: async (url) => (sent.push(url), { ok: true }),
  });
  await forwarder.send();
  assert.deepEqual(sent, []);
  assert.equal(forwarder.point('http://192.168.4.55:8790'), true);
  assert.equal(forwarder.point('http://192.168.4.55:8790/'), false);
  await forwarder.send();
  assert.deepEqual(sent, ['http://192.168.4.55:8790/peer']);
});
