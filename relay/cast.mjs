import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_MS = 30 * 24 * 3600e3;
const TINT_STEP = 55;
const REST_SECONDS = { working: 6, bored: 6, sleeping: 4 };

const withRests = (states) => Object.fromEntries(Object.entries(states).map(([name, state]) => [name, state.loop ? { ...state, rest: REST_SECONDS[name] ?? 0 } : state]));

export class Cast {
  characters = [];
  assignments = {};

  constructor(dir, dataDir = dir) {
    this.dir = dir;
    this.file = join(dataDir, 'assignments.json');
    this.reload();
    try {
      this.assignments = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.assignments = {};
    }
  }

  reload() {
    if (!existsSync(this.dir)) return (this.characters = []);
    this.characters = readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.dir, d.name, 'character.json')))
      .map((d) => JSON.parse(readFileSync(join(this.dir, d.name, 'character.json'), 'utf8')));
  }

  #save(now) {
    for (const [id, a] of Object.entries(this.assignments)) if (now - a.at > KEEP_MS) delete this.assignments[id];
    try {
      writeFileSync(this.file, JSON.stringify(this.assignments, null, 2) + '\n');
    } catch {}
  }

  assign(sessionId, activeSessionIds, now = Date.now()) {
    const known = new Map(this.characters.map((c) => [c.id, c]));
    const existing = this.assignments[sessionId];
    if (existing && known.has(existing.character)) return existing;
    if (this.characters.length === 0) return null;

    const inUse = new Map();
    for (const id of activeSessionIds) {
      const a = this.assignments[id];
      if (a && id !== sessionId) inUse.set(a.character, (inUse.get(a.character) ?? 0) + 1);
    }
    const lastUsed = new Map();
    for (const a of Object.values(this.assignments)) lastUsed.set(a.character, Math.max(lastUsed.get(a.character) ?? 0, a.at));
    const byAge = [...this.characters].sort((a, b) => (lastUsed.get(a.id) ?? 0) - (lastUsed.get(b.id) ?? 0));
    const pick = byAge.find((c) => !inUse.has(c.id)) ?? byAge.reduce((a, b) => ((inUse.get(b.id) ?? 0) < (inUse.get(a.id) ?? 0) ? b : a));

    const assignment = { character: pick.id, tint: (inUse.get(pick.id) ?? 0) * TINT_STEP, at: now };
    this.assignments[sessionId] = assignment;
    this.#save(now);
    return assignment;
  }

  describe(assignment) {
    const c = assignment && this.characters.find((x) => x.id === assignment.character);
    if (!c) return null;
    return { id: c.id, tint: assignment.tint, frame: c.frame, still: c.still, tv: c.tv, states: withRests(c.states) };
  }
}
