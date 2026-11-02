import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REFRESH_MS = 2000;

const QUERY = `
  select lower(hex(p.uuid)) as id, coalesce(nullif(trim(t.custom_title), ''), nullif(trim(l.custom_vertical_tabs_title), '')) as title
  from terminal_panes p
  join pane_nodes n on n.id = p.id
  join tabs t on t.id = n.tab_id
  left join pane_leaves l on l.pane_node_id = p.id`;

export function warpDatabase(env = process.env, platform = process.platform) {
  if (env.HANDLER_WARP_DB) return env.HANDLER_WARP_DB;
  const candidates =
    platform === 'win32'
      ? [join(env.LOCALAPPDATA ?? '', 'warp', 'Warp', 'data', 'warp.sqlite')]
      : platform === 'darwin'
        ? [join(homedir(), 'Library', 'Group Containers', '2BBY89MBSN.dev.warp', 'Library', 'Application Support', 'dev.warp.Warp-Stable', 'warp.sqlite')]
        : [join(homedir(), '.local', 'state', 'warp-terminal', 'warp.sqlite')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export class WarpTabs {
  titles = new Map();
  loadedAt = -Infinity;
  db = null;

  constructor(path, { log = () => {} } = {}) {
    this.path = path;
    this.log = log;
  }

  async open() {
    if (!this.path || this.db) return;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      this.db = new DatabaseSync(this.path, { readOnly: true });
      this.query = this.db.prepare(QUERY);
    } catch (err) {
      this.log(`warp: ${err.message}`);
      this.path = null;
    }
  }

  refresh(now = Date.now()) {
    if (!this.query || now - this.loadedAt < REFRESH_MS) return false;
    this.loadedAt = now;
    let rows;
    try {
      rows = this.query.all();
    } catch (err) {
      this.log(`warp: ${err.message}`);
      return false;
    }
    const next = new Map(rows.filter((r) => r.title).map((r) => [r.id, r.title]));
    const changed = next.size !== this.titles.size || [...next].some(([id, title]) => this.titles.get(id) !== title);
    this.titles = next;
    return changed;
  }

  title(id) {
    return id ? (this.titles.get(String(id).toLowerCase().replaceAll('-', '')) ?? null) : null;
  }
}
