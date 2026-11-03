export const PEER_TIMEOUT_MS = 45000;
export const HEARTBEAT_MS = 15000;

export class Peers {
  peers = new Map();

  accept(body, now = Date.now()) {
    const host = typeof body?.host === 'string' ? body.host.slice(0, 80) : '';
    if (!host || !Array.isArray(body.sessions)) throw new Error('bad peer body');
    const sessions = body.sessions
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => ({ ...s, host: s.host ?? host, character: undefined }));
    const key = JSON.stringify(sessions);
    const prev = this.peers.get(host);
    this.peers.set(host, { sessions, key, seen: now });
    return prev?.key !== key;
  }

  sweep(now = Date.now()) {
    let changed = false;
    for (const [host, p] of this.peers) {
      if (now - p.seen > PEER_TIMEOUT_MS) {
        this.peers.delete(host);
        changed ||= p.sessions.length > 0;
      }
    }
    return changed;
  }

  sessions() {
    return [...this.peers.values()].flatMap((p) => p.sessions);
  }

  hosts() {
    return [...this.peers.entries()].map(([host, p]) => ({ host, sessions: p.sessions.length, seen: new Date(p.seen).toISOString() }));
  }
}

export class Forwarder {
  constructor({ url, host, snapshot, log = () => {}, fetchImpl = fetch }) {
    this.point(url);
    this.host = host;
    this.snapshot = snapshot;
    this.log = log;
    this.fetch = fetchImpl;
    this.sending = false;
    this.again = false;
    this.ok = null;
  }

  point(url) {
    const next = url ? url.replace(/\/+$/, '') + '/peer' : null;
    if (next === this.url) return false;
    this.url = next;
    this.ok = null;
    return true;
  }

  async send() {
    if (!this.url) return;
    if (this.sending) return void (this.again = true);
    this.sending = true;
    try {
      const { sessions } = this.snapshot();
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: this.host, sessions }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (this.ok !== true) this.log(`forwarding to ${this.url}`);
      this.ok = true;
    } catch (err) {
      if (this.ok !== false) this.log(`forward to ${this.url} failed: ${err.message}`);
      this.ok = false;
    } finally {
      this.sending = false;
      if (this.again) {
        this.again = false;
        this.send();
      }
    }
  }
}

export const IDLE_HIDE_MS = 4 * 3600e3;

export function hideIdle(sessions, now = Date.now()) {
  return sessions.filter((s) => s.needsYou || (s.state !== 'waiting' && s.state !== 'stale') || now - Date.parse(s.lastEvent) <= IDLE_HIDE_MS);
}

const RANK = { working: 1, waiting: 2, stale: 3 };

export function sortSessions(sessions) {
  const rank = (x) => (x.needsYou ? 0 : RANK[x.state] ?? 4);
  return sessions.sort((a, b) => rank(a) - rank(b) || (a.needsYou ? a.since.localeCompare(b.since) : b.lastEvent.localeCompare(a.lastEvent)));
}
