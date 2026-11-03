import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Board } from './state.mjs';
import { Cast } from './cast.mjs';
import { checkTranscript, hasOutcome } from './transcript.mjs';
import { summarise } from './summarise.mjs';
import { Forwarder, HEARTBEAT_MS, Peers, sortSessions } from './peers.mjs';
import { isQuiet, parseQuiet } from './quiet.mjs';
import { WarpTabs, warpDatabase } from './warp.mjs';
import { readBoard, writeBoard } from './store.mjs';
import { liveDir, readLive } from './live.mjs';
import { Mains, deviceInfo, findRokuIps, isLocal, localAddressFor, startDiscovery } from './discovery.mjs';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8790' },
    verbose: { type: 'boolean', short: 'v', default: false },
    'no-summaries': { type: 'boolean', default: false },
    roku: { type: 'string', default: process.env.HANDLER_ROKU ?? '' },
    forward: { type: 'string', default: process.env.HANDLER_FORWARD ?? '' },
    'forward-host': { type: 'string', default: process.env.HANDLER_FORWARD_HOST ?? '' },
    name: { type: 'string', default: hostname() },
    'discovery-port': { type: 'string', default: '' },
    'no-discovery': { type: 'boolean', default: false },
    data: { type: 'string', default: process.env.HANDLER_DATA ?? '' },
    parent: { type: 'string', default: '' },
    quiet: { type: 'string', default: process.env.HANDLER_QUIET ?? '' },
  },
});

const quietHours = parseQuiet(args.quiet);

const rokus = args.roku.split(',').map((ip) => ip.trim()).filter(Boolean);

const MAX_BODY = 1024 * 1024;
const SWEEP_MS = 2000;
const BROADCAST_DELAY_MS = 150;
const ROKU_PUSH_MS = 30000;

function locate(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      let branch = null;
      try {
        const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim();
        branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7);
      } catch {}
      return { project: basename(dir), branch };
    }
    if (dirname(dir) === dir) return { project: basename(cwd) || cwd, branch: null };
  }
}

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

const warp = new WarpTabs(warpDatabase(), { log });

const board = new Board({
  locate,
  tabName: (id) => warp.title(id),
  onNewEventType: (name, keys) => args.verbose && log(`first ${name}: ${keys.join(', ')}`),
});

const sessionsDir = liveDir();
const scanLive = () => board.syncLive(readLive(sessionsDir, { host: args.name }));

const CHARACTERS = join(import.meta.dirname, '..', 'characters');
if (args.data) mkdirSync(args.data, { recursive: true });
const boardFile = args.data ? join(args.data, 'board.json') : null;
if (boardFile) {
  try {
    const restored = board.restore(readBoard(boardFile));
    if (args.verbose) log(`restored ${restored} sessions from ${boardFile}`);
  } catch (err) {
    board.sessions.clear();
    log(`couldn't restore the board: ${err.message}`);
  }
}
scanLive();
const cast = new Cast(CHARACTERS, args.data || CHARACTERS);
if (args.verbose) log(`cast: ${cast.characters.map((c) => c.id).join(', ') || 'none'}`);

const peers = new Peers();

const followHost = args.forward ? '' : args['forward-host'];
const forwarder =
  args.forward || followHost
    ? new Forwarder({ url: args.forward || null, host: args.name, snapshot: () => board.snapshot(), log })
    : null;

const mains = args['no-discovery'] ? new Mains(args.name) : startDiscovery({
  name: args.name,
  port: Number(args.port),
  isMain: !forwarder,
  log,
  ...(args['discovery-port'] ? { discoveryPort: Number(args['discovery-port']) } : {}),
  onMain: (main) => {
    if (main.host !== followHost) return;
    if (forwarder.point(`http://${main.address}:${main.port}`)) forwarder.send();
  },
});

async function pushRelayUrl(ip) {
  try {
    const active = await (await fetch(`http://${ip}:8060/query/active-app`, { signal: AbortSignal.timeout(2000) })).text();
    if (!/<(app|screensaver) id="dev"/.test(active)) return;
    const url = `http://${localAddressFor(ip)}:${args.port}`;
    await fetch(`http://${ip}:8060/input?handler=relay&url=${encodeURIComponent(url)}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch (err) {
    if (args.verbose) log(`roku ${ip} relay push failed: ${err.message}`);
  }
}

async function findRokus() {
  const ips = await findRokuIps();
  return (await Promise.all(ips.map((ip) => deviceInfo(ip)))).filter(Boolean).map(({ ip, name, model, serial }) => ({ ip, name, model, serial }));
}

function status() {
  const snap = board.snapshot();
  snap.sessions = sortSessions([...snap.sessions, ...peers.sessions()]);
  snap.quiet = isQuiet(quietHours);
  const active = snap.sessions.map((s) => s.id);
  for (const s of snap.sessions) s.character = cast.describe(cast.assign(s.id, active));
  return snap;
}

const SAFE_NAME = /^[\w-]+$/;
const SAFE_FILE = /^[\w-]+\.(png|json)$/;

const isLoopback = (address = '') => /^(::1|127\.|::ffff:127\.)/.test(address);

const clients = new Set();
let broadcastTimer = null;
let lastSeq = -1;

function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (board.seq === lastSeq) return;
    lastSeq = board.seq;
    forwarder?.send();
    const snap = status();
    pushToRokus(snap);
    const data = `data: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) res.write(data);
  }, BROADCAST_DELAY_MS);
}

const needsYouOf = (snap) => new Set(snap.sessions.filter((s) => s.needsYou).map((s) => `${s.id}|${s.since}`));

let needsYouKeys = needsYouOf(status());

function pushToRokus(snap) {
  const keys = needsYouOf(snap);
  const fresh = [...keys].some((k) => !needsYouKeys.has(k));
  needsYouKeys = keys;
  if (!fresh) return;
  for (const ip of rokus) {
    fetch(`http://${ip}:8060/input?handler=alert&seq=${snap.seq}`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      .then((res) => args.verbose && log(`roku ${ip} alert → ${res.status}`))
      .catch((err) => args.verbose && log(`roku ${ip} alert failed: ${err.message}`));
  }
}

let summarising = false;

async function pumpSummaries() {
  if (summarising || args['no-summaries']) return;
  const job = board.nextSummary();
  if (!job) return;
  summarising = true;
  const started = Date.now();
  try {
    const line = await summarise(job);
    if (board.setSummary(job, line)) broadcast();
    if (args.verbose) log(`${job.project} ${job.sessionId.slice(0, 8)} summary in ${Date.now() - started}ms: ${line}`);
  } catch (err) {
    if (args.verbose) log(`${job.project} ${job.sessionId.slice(0, 8)} summary failed: ${err.message}`);
  } finally {
    summarising = false;
    pumpSummaries();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const page = () => readFileSync(join(import.meta.dirname, 'public', 'index.html'));

const DEMO_BASE = Date.now();

function demoStatus() {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, 'public', 'demo.json'), 'utf8'));
  const ids = cast.characters.map((c) => c.id);
  const at = (offset) => new Date(DEMO_BASE + Number(offset) * 1000).toISOString();
  demo.sessions.forEach((s, i) => {
    if (ids.length) s.character = cast.describe({ character: ids[i % ids.length], tint: Math.floor(i / ids.length) * 55 });
    for (const key of ['since', 'lastEvent', 'started']) s[key] = at(s[key]);
  });
  return { ...demo, now: new Date().toISOString() };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname === '/demo/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(demoStatus()));
  }
  if (url.pathname.startsWith('/demo/characters/')) url.pathname = url.pathname.slice(5);
  try {
    if (req.method === 'POST' && url.pathname === '/events') {
      if (!isLocal(req.socket.remoteAddress)) return res.writeHead(403).end();
      const event = JSON.parse(await readBody(req));
      const before = board.snapshot().sessions.find((s) => s.id === event.session_id)?.state;
      if (board.apply(event)) {
        board.sweep();
        broadcast();
        pumpSummaries();
        if (args.verbose) {
          const after = board.snapshot().sessions.find((s) => s.id === event.session_id);
          if (after && after.state !== before) log(`${after.project} ${event.session_id.slice(0, 8)} ${before ?? '-'} → ${after.state}${after.detail ? ` (${after.detail})` : ''}`);
        }
      }
      return res.writeHead(204).end();
    }
    if (req.method === 'POST' && url.pathname === '/peer') {
      if (!isLocal(req.socket.remoteAddress)) return res.writeHead(403).end();
      const body = JSON.parse(await readBody(req));
      const isNew = !peers.peers.has(body?.host);
      if (peers.accept(body)) {
        board.seq++;
        broadcast();
      }
      if (isNew && args.verbose) log(`peer ${body.host} joined`);
      return res.writeHead(204).end();
    }
    if (req.method === 'GET' && url.pathname === '/peers') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(peers.hosts()));
    }
    if (req.method === 'GET' && url.pathname === '/discover') {
      if (!isLoopback(req.socket.remoteAddress)) return res.writeHead(403).end();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ rokus: await findRokus() }));
    }
    if (req.method === 'GET' && url.pathname === '/mains') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(
        JSON.stringify({
          mains: mains.list().map(({ host, address, port }) => ({ host, address, port })),
          forwarding: forwarder ? { host: followHost || null, url: forwarder.url, ok: forwarder.ok } : null,
        }),
      );
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(status()));
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(status())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page());
    }
    const charFile = /^\/characters\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && charFile && SAFE_NAME.test(charFile[1]) && SAFE_FILE.test(charFile[2])) {
      const path = join(CHARACTERS, charFile[1], charFile[2]);
      if (!existsSync(path)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': charFile[2].endsWith('.png') ? 'image/png' : 'application/json', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      return res.end(readFileSync(path));
    }
    if (req.method === 'GET' && url.pathname === '/characters/reload') {
      cast.reload();
      board.seq++;
      broadcast();
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(cast.characters.map((c) => c.id)));
    }
    if (req.method === 'GET' && url.pathname === '/demo.json') {
      const demo = JSON.parse(readFileSync(join(import.meta.dirname, 'public', 'demo.json'), 'utf8'));
      const ids = cast.characters.map((c) => c.id);
      demo.sessions.forEach((s, i) => {
        if (ids.length) s.character = cast.describe({ character: ids[i % ids.length], tint: Math.floor(i / ids.length) * 55 });
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(demo));
    }
    res.writeHead(404).end();
  } catch (err) {
    if (args.verbose) log('error', err.message);
    if (!res.headersSent) res.writeHead(400).end();
  }
});

setInterval(async () => {
  let changed = scanLive();
  if (board.sweep()) changed = true;
  if (warp.refresh()) {
    board.seq++;
    changed = true;
  }
  if (peers.sweep()) {
    board.seq++;
    changed = true;
  }
  for (const target of board.watchTargets()) {
    const outcome = await checkTranscript(target);
    if (hasOutcome(outcome) && board.resolve(target.sessionId, target.agentKey, outcome)) {
      changed = true;
      if (args.verbose) log(`${target.sessionId.slice(0, 8)} ${target.agentKey} from transcript: ${JSON.stringify(outcome)}`);
    }
  }
  if (changed) broadcast();
  pumpSummaries();
}, SWEEP_MS);

if (boardFile) {
  let savedSeq = board.seq;
  setInterval(() => {
    if (board.seq === savedSeq) return;
    try {
      writeBoard(boardFile, board.dump());
      savedSeq = board.seq;
    } catch (err) {
      log(`couldn't save the board: ${err.message}`);
    }
  }, SWEEP_MS);
}

if (forwarder) {
  setInterval(() => forwarder.send(), HEARTBEAT_MS);
  forwarder.send();
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000);

if (args.parent) {
  setInterval(() => {
    try {
      process.kill(Number(args.parent), 0);
    } catch (err) {
      if (err.code !== 'EPERM') {
        log(`parent ${args.parent} is gone; stopping`);
        process.exit(0);
      }
    }
  }, 3000);
}

if (!forwarder && rokus.length) {
  const pushAll = () => rokus.forEach(pushRelayUrl);
  setInterval(pushAll, ROKU_PUSH_MS);
  pushAll();
}

server.listen(Number(args.port), '0.0.0.0', () => log(`Handler relay on http://localhost:${args.port}/`));

warp.open().then(() => {
  if (args.verbose && warp.query) log(`warp tabs: ${warp.path}`);
  if (warp.refresh()) {
    board.seq++;
    broadcast();
  }
});
