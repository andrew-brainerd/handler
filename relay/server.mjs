import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Board } from './state.mjs';
import { Cast } from './cast.mjs';
import { checkTranscript, hasOutcome } from './transcript.mjs';
import { summarise } from './summarise.mjs';
import { Forwarder, HEARTBEAT_MS, Peers, sortSessions } from './peers.mjs';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8790' },
    verbose: { type: 'boolean', short: 'v', default: false },
    'no-summaries': { type: 'boolean', default: false },
    roku: { type: 'string', default: process.env.TALLY_ROKU ?? '' },
    forward: { type: 'string', default: process.env.TALLY_FORWARD ?? '' },
  },
});

const rokus = args.roku.split(',').map((ip) => ip.trim()).filter(Boolean);

const MAX_BODY = 1024 * 1024;
const SWEEP_MS = 2000;
const BROADCAST_DELAY_MS = 150;

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

const board = new Board({
  locate,
  onNewEventType: (name, keys) => args.verbose && log(`first ${name}: ${keys.join(', ')}`),
});

const CHARACTERS = join(import.meta.dirname, '..', 'characters');
const cast = new Cast(CHARACTERS);
if (args.verbose) log(`cast: ${cast.characters.map((c) => c.id).join(', ') || 'none'}`);

const peers = new Peers();

const forwarder = args.forward
  ? new Forwarder({ url: args.forward, host: hostname(), snapshot: () => board.snapshot(), log })
  : null;

function status() {
  const snap = board.snapshot();
  snap.sessions = sortSessions([...snap.sessions, ...peers.sessions()]);
  const active = snap.sessions.map((s) => s.id);
  for (const s of snap.sessions) s.character = cast.describe(cast.assign(s.id, active));
  return snap;
}

const SAFE_NAME = /^[\w-]+$/;
const SAFE_FILE = /^[\w-]+\.(png|json)$/;

const isLocal = (address = '') => {
  const ip = address.replace(/^::ffff:/, '');
  return ip === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
};

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

let needsYouKeys = new Set();

function pushToRokus(snap) {
  const keys = new Set(snap.sessions.filter((s) => s.needsYou).map((s) => `${s.id}|${s.since}`));
  const fresh = [...keys].some((k) => !needsYouKeys.has(k));
  needsYouKeys = keys;
  if (!fresh) return;
  for (const ip of rokus) {
    fetch(`http://${ip}:8060/input?tally=alert&seq=${snap.seq}`, { method: 'POST', signal: AbortSignal.timeout(2000) })
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

function demoStatus() {
  const demo = JSON.parse(readFileSync(join(import.meta.dirname, 'public', 'demo.json'), 'utf8'));
  const ids = cast.characters.map((c) => c.id);
  const at = (offset) => new Date(Date.now() + Number(offset) * 1000).toISOString();
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
  let changed = board.sweep();
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

if (forwarder) {
  setInterval(() => forwarder.send(), HEARTBEAT_MS);
  forwarder.send();
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000);

server.listen(Number(args.port), '0.0.0.0', () => log(`Tally relay on http://localhost:${args.port}/`));
