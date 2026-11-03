import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastAddresses, isLocal, lanAddresses, localAddressFor, MAIN_TIMEOUT_MS, Mains, parseDeviceInfo, parseMessage } from '../relay/discovery.mjs';
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

test('lanAddresses skips loopback and IPv6', () => {
  const nets = { a: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }, { family: 'IPv6', internal: false, address: 'fe80::1' }], b: [{ family: 'IPv4', internal: false, address: '192.168.4.55' }] };
  assert.deepEqual(lanAddresses(nets), ['192.168.4.55']);
});

test('localAddressFor picks the interface on the same subnet', () => {
  const nets = { vpn: [{ family: 'IPv4', internal: false, address: '10.8.0.2', netmask: '255.255.255.0' }], lan: [{ family: 'IPv4', internal: false, address: '192.168.4.55', netmask: '255.255.252.0' }] };
  assert.equal(localAddressFor('192.168.4.46', nets), '192.168.4.55');
  assert.equal(localAddressFor('172.16.0.1', nets), '10.8.0.2');
});

test('parseDeviceInfo reads the identity of a TV', () => {
  const xml = '<device-info><serial-number>X1</serial-number><model-name>43R4CX</model-name><friendly-device-name>Office TV</friendly-device-name><developer-enabled>true</developer-enabled></device-info>';
  assert.deepEqual(parseDeviceInfo('192.168.4.46', xml), { ip: '192.168.4.46', name: 'Office TV', model: '43R4CX', serial: 'X1', devMode: true, keyedDevId: null });
});
