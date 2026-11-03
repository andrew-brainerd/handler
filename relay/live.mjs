import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const liveDir = (env = process.env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLive(dir, { host = null, alive = pidAlive } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    return err.code === 'ENOENT' ? [] : null;
  }
  const live = [];
  try {
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let entry;
      try {
        entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      if (entry.kind !== 'interactive' || entry.entrypoint?.startsWith('sdk') || !entry.sessionId || !Number.isInteger(entry.pid) || !alive(entry.pid)) continue;
      live.push({ id: entry.sessionId, cwd: entry.cwd ?? null, status: entry.status ?? null, startedAt: entry.startedAt, updatedAt: entry.updatedAt, host });
    }
  } catch {
    return null;
  }
  return live;
}
