import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';

export const DISCOVERY_PORT = 8791;
export const BEACON_MS = 5000;
export const MAIN_TIMEOUT_MS = 20000;
const MAGIC = 'handler-relay';

export const isLocal = (address = '') => {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
};

export function parseMessage(buffer) {
  let m;
  try {
    m = JSON.parse(String(buffer));
  } catch {
    return null;
  }
  if (m?.magic !== MAGIC) return null;
  if (m.type === 'looking') return { type: 'looking' };
  const validHost = typeof m.host === 'string' && m.host.length > 0 && m.host.length <= 80;
  const validPort = Number.isInteger(m.port) && m.port >= 1024 && m.port <= 65535;
  return m.type === 'here' && validHost && validPort ? { type: 'here', host: m.host, port: m.port } : null;
}

export function broadcastAddresses(interfaces = networkInterfaces()) {
  const found = new Set();
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      found.add(ip.map((part, n) => (part | ~mask[n]) & 255).join('.'));
    }
  }
  return [...found];
}

export class Mains {
  heard = new Map();

  constructor(self) {
    this.self = self;
  }

  note({ host, port }, address, now = Date.now()) {
    if (host === this.self) return null;
    const main = { host, address: address.replace(/^::ffff:/, ''), port, seen: now };
    this.heard.set(host, main);
    return main;
  }

  list(now = Date.now()) {
    return [...this.heard.values()].filter((m) => now - m.seen <= MAIN_TIMEOUT_MS).sort((a, b) => a.host.localeCompare(b.host));
  }
}

export function startDiscovery({ name, port, isMain, onMain = () => {}, log = () => {}, discoveryPort = DISCOVERY_PORT, addresses = broadcastAddresses }) {
  const mains = new Mains(name);
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const here = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'here', host: name, port }));
  const looking = Buffer.from(JSON.stringify({ magic: MAGIC, type: 'looking' }));
  const failed = new Set();

  const send = (message, address, target = discoveryPort) =>
    socket.send(message, target, address, (err) => {
      if (err && !failed.has(err.code)) {
        failed.add(err.code);
        log(`discovery: can't reach ${address}: ${err.message}`);
      }
    });

  const announce = () => {
    for (const address of addresses()) {
      send(looking, address);
      if (isMain) send(here, address);
    }
  };

  socket.on('error', (err) => log(`discovery: ${err.message}`));
  socket.on('message', (buffer, from) => {
    if (!isLocal(from.address)) return;
    const message = parseMessage(buffer);
    if (message?.type === 'looking') {
      if (isMain) send(here, from.address, from.port);
    } else if (message?.type === 'here') {
      const main = mains.note(message, from.address);
      if (main) onMain(main);
    }
  });
  socket.bind(discoveryPort, () => {
    socket.setBroadcast(true);
    socket.unref();
    announce();
    setInterval(announce, BEACON_MS).unref();
  });
  return mains;
}
