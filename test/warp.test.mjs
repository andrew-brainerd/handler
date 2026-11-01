import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WarpTabs, warpDatabase } from '../relay/warp.mjs';
import { Board } from '../relay/state.mjs';

const A = 'd9c31a9d2be74454aea27416f405d88f';
const B = '0123456789abcdef0123456789abcdef';

function fakeWarp(dir) {
  const path = join(dir, 'warp.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    create table tabs (id integer primary key, window_id integer, custom_title text);
    create table pane_nodes (id integer primary key, tab_id integer);
    create table pane_leaves (pane_node_id integer, kind text, custom_vertical_tabs_title text);
    create table terminal_panes (id integer primary key, uuid blob);
    insert into tabs values (1, 1, 'Claude Roku App'), (2, 1, null);
    insert into pane_nodes values (10, 1), (20, 2);
    insert into pane_leaves values (10, 'terminal', null), (20, 'terminal', null);
    insert into terminal_panes values (10, x'${A}'), (20, x'${B}');`);
  return { path, db };
}

test('reads custom tab titles by terminal session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-warp-'));
  const { path, db } = fakeWarp(dir);
  const warp = new WarpTabs(path);
  await warp.open();
  assert.equal(warp.refresh(0), true);
  assert.equal(warp.title(A), 'Claude Roku App');
  assert.equal(warp.title(A.toUpperCase()), 'Claude Roku App');
  assert.equal(warp.title(B), null);
  assert.equal(warp.title(undefined), null);

  db.exec("update tabs set custom_title = 'Tally' where id = 2");
  assert.equal(warp.refresh(1000), false);
  assert.equal(warp.refresh(5000), true);
  assert.equal(warp.title(B), 'Tally');
  assert.equal(warp.refresh(10000), false);
  warp.db.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('missing database leaves titles empty', async () => {
  const warp = new WarpTabs(null);
  await warp.open();
  assert.equal(warp.refresh(), false);
  assert.equal(warp.title(A), null);
  assert.equal(warpDatabase({ TALLY_WARP_DB: 'x.sqlite' }), 'x.sqlite');
});

test('board shows the tab title and keeps the folder', () => {
  const board = new Board({ tabName: (id) => (id === A ? 'Claude Roku App' : null) });
  const base = { hook_event_name: 'UserPromptSubmit', prompt: 'hi', cwd: 'C:\\Users\\drwb3' };
  board.apply({ ...base, session_id: 's1', warp_session: A });
  board.apply({ ...base, session_id: 's2' });
  const rows = Object.fromEntries(board.snapshot().sessions.map((s) => [s.id, s]));
  assert.equal(rows.s1.project, 'Claude Roku App');
  assert.equal(rows.s1.folder, 'drwb3');
  assert.equal(rows.s2.project, 'drwb3');
});
