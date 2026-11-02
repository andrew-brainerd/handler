import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

export function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket('udp4');
    const search = [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'ST: roku:ecp',
      'MX: 2',
      '',
      '',
    ].join('\r\n');
    socket.on('message', (msg, rinfo) => {
      if (/roku:ecp/i.test(msg.toString())) found.set(rinfo.address, true);
    });
    socket.bind(() => socket.send(search, 1900, '239.255.255.250'));
    setTimeout(() => {
      socket.close();
      resolve([...found.keys()]);
    }, timeoutMs);
  });
}

export async function deviceInfo(ip, timeoutMs = 2000) {
  try {
    const xml = await (await fetch(`http://${ip}:8060/query/device-info`, { signal: AbortSignal.timeout(timeoutMs) })).text();
    const pick = (tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
    return {
      ip,
      name: pick('user-device-name') || pick('friendly-device-name') || pick('model-name') || 'Roku',
      devMode: pick('developer-enabled') === 'true',
      keyedDevId: pick('keyed-developer-id') || null,
    };
  } catch {
    return null;
  }
}

export async function deviceName(ip) {
  return (await deviceInfo(ip))?.name ?? 'Roku';
}

function toInt(ip) {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function fromInt(n) {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

export async function scanSubnets() {
  const hosts = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      const size = (~mask >>> 0) + 1;
      if (size > 1024) continue;
      const network = (toInt(a.address) & mask) >>> 0;
      for (let i = 1; i < size - 1; i++) hosts.add(fromInt(network + i));
    }
  }
  return (await Promise.all([...hosts].map((ip) => deviceInfo(ip, 2500)))).filter(Boolean);
}

export async function findRokus() {
  const ssdp = await discover();
  if (ssdp.length) return (await Promise.all(ssdp.map((ip) => deviceInfo(ip)))).filter(Boolean);
  return scanSubnets();
}

export async function resolveRoku(target) {
  if (target && /^\d+\.\d+\.\d+\.\d+$/.test(target)) return target;
  const found = await findRokus();
  const candidates = target
    ? found.filter((d) => d.name.toLowerCase() === target.toLowerCase())
    : found.filter((d) => d.devMode);
  if (candidates.length === 1) return candidates[0].ip;
  const list = found.map((d) => `  ${d.ip}  ${d.name}${d.devMode ? '' : '  (developer mode off)'}`).join('\n');
  if (!found.length) throw new Error('No Roku found on the network. Pass --roku <ip> (Settings > Network > About on the TV).');
  throw new Error(`${target ? `No Roku named "${target}".` : 'Pick a Roku with --roku <ip or name>.'}\n${list}`);
}

export function localAddressFor(rokuIp) {
  const target = toInt(rokuIp);
  let fallback;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      if (((toInt(a.address) & mask) >>> 0) === ((target & mask) >>> 0)) return a.address;
      fallback ??= a.address;
    }
  }
  return fallback;
}

export function devCurl(ip, password, path, extraArgs) {
  return execFileSync(
    'curl',
    ['--silent', '--show-error', '--fail-with-body', '--digest', '--user', `rokudev:${password}`, ...extraArgs, `http://${ip}${path}`],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
}

export function requirePassword(password) {
  const value = password ?? process.env.ROKU_DEV_PASSWORD;
  if (!value) throw new Error('Set ROKU_DEV_PASSWORD (the password you chose when enabling developer mode) or pass --password.');
  return value;
}

const root = path.resolve(import.meta.dirname, '..');

export function buildChannelZip(relayUrl) {
  const buildDir = path.join(root, 'build');
  const stage = path.join(buildDir, 'stage');
  const zip = path.join(buildDir, 'handler.zip');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(root, 'roku'), stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'source', 'config.brs'), `function RelayUrl() as String\n    return ${JSON.stringify(relayUrl)}\nend function\n`);
  const entries = {};
  for (const rel of fs.readdirSync(stage, { recursive: true })) {
    const full = path.join(stage, rel);
    if (fs.statSync(full).isFile()) entries[rel.split(path.sep).join('/')] = fs.readFileSync(full);
  }
  fs.writeFileSync(zip, zipSync(entries, { level: 9 }));
  console.log(`built ${path.relative(root, zip)} -> ${relayUrl}`);
  return zip;
}

export function devPost(ip, password, path, fields) {
  try {
    return devCurl(ip, password, path, fields.flatMap((f) => ['-F', f])).toString();
  } catch (err) {
    const body = err.stdout?.toString() ?? '';
    if (/401/.test(err.stderr?.toString() ?? '')) throw new Error('Roku rejected the developer password.');
    if (!body) throw err;
    return body;
  }
}

export function statusText(body) {
  const messages = [...body.matchAll(/"text":"([^"]+)"/g)].map((m) => m[1]);
  const fallback = body.match(/Install Success|Identical to previous version|Install Failure[^<"]*|Compilation Failed[^<"]*/g) ?? [];
  return (messages.length ? messages : fallback).join(' / ') || 'no status in response';
}

export async function installZip(ip, password, zip) {
  console.log(`installing on ${await deviceName(ip)} (${ip})...`);
  const result = statusText(devPost(ip, password, '/plugin_install', ['mysubmit=Install', `archive=@${zip}`]));
  console.log(result);
  if (/fail/i.test(result)) {
    console.log(`Compile errors are on the debug console: ${ip}:8085`);
    process.exit(1);
  }
}
