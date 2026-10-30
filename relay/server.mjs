import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Board } from './state.mjs';
import { checkTranscript, hasOutcome } from './transcript.mjs';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8790' },
    verbose: { type: 'boolean', short: 'v', default: false },
  },
});

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
    const data = `data: ${JSON.stringify(board.snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }, BROADCAST_DELAY_MS);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  try {
    if (req.method === 'POST' && url.pathname === '/events') {
      if (!isLocal(req.socket.remoteAddress)) return res.writeHead(403).end();
      const event = JSON.parse(await readBody(req));
      const before = board.snapshot().sessions.find((s) => s.id === event.session_id)?.state;
      if (board.apply(event)) {
        board.sweep();
        broadcast();
        if (args.verbose) {
          const after = board.snapshot().sessions.find((s) => s.id === event.session_id);
          if (after && after.state !== before) log(`${after.project} ${event.session_id.slice(0, 8)} ${before ?? '-'} → ${after.state}${after.detail ? ` (${after.detail})` : ''}`);
        }
      }
      return res.writeHead(204).end();
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(board.snapshot()));
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(board.snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(page());
    }
    if (req.method === 'GET' && url.pathname === '/demo.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(import.meta.dirname, 'public', 'demo.json')));
    }
    res.writeHead(404).end();
  } catch (err) {
    if (args.verbose) log('error', err.message);
    if (!res.headersSent) res.writeHead(400).end();
  }
});

setInterval(async () => {
  let changed = board.sweep();
  for (const target of board.watchTargets()) {
    const outcome = await checkTranscript(target);
    if (hasOutcome(outcome) && board.resolve(target.sessionId, target.agentKey, outcome)) {
      changed = true;
      if (args.verbose) log(`${target.sessionId.slice(0, 8)} ${target.agentKey} from transcript: ${JSON.stringify(outcome)}`);
    }
  }
  if (changed) broadcast();
}, SWEEP_MS);

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 20000);

server.listen(Number(args.port), '0.0.0.0', () => log(`Tally relay on http://localhost:${args.port}/`));
