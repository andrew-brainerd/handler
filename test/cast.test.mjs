import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cast } from '../relay/cast.mjs';

function castWith(ids) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-cast-'));
  for (const id of ids) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'character.json'), JSON.stringify({ id, frame: { w: 64, h: 64 }, still: 'still.png', states: {} }));
  }
  return { dir, cast: new Cast(dir) };
}

test('no characters means no assignment', () => {
  const { dir, cast } = castWith([]);
  assert.equal(cast.assign('s1', ['s1']), null);
  rmSync(dir, { recursive: true });
});

test('active sessions get different characters, then a tinted repeat', () => {
  const { dir, cast } = castWith(['robot', 'wizard']);
  const a = cast.assign('s1', ['s1'], 1);
  const b = cast.assign('s2', ['s1', 's2'], 2);
  const c = cast.assign('s3', ['s1', 's2', 's3'], 3);
  assert.notEqual(a.character, b.character);
  assert.equal(a.tint, 0);
  assert.equal(b.tint, 0);
  assert.ok(c.tint > 0);
  rmSync(dir, { recursive: true });
});

test('a session keeps its character across a reload (resume or relay restart)', () => {
  const { dir, cast } = castWith(['robot', 'wizard', 'fox']);
  const first = cast.assign('s1', ['s1'], 1);
  const again = new Cast(dir).assign('s1', ['s1', 's9'], 5);
  assert.deepEqual(again, first);
  rmSync(dir, { recursive: true });
});

test('a free character is preferred, least recently used first', () => {
  const { dir, cast } = castWith(['robot', 'wizard']);
  cast.assign('old', [], 1);
  const next = cast.assign('new', [], 2);
  assert.notEqual(next.character, cast.assignments.old.character);
  rmSync(dir, { recursive: true });
});
