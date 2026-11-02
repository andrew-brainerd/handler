import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard, writeBoard } from '../relay/store.mjs';

const inTemp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-store-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a saved board reads back, replacing the last save and leaving no temp file', () =>
  inTemp((dir) => {
    const path = join(dir, 'board.json');
    writeBoard(path, { seq: 1 });
    writeBoard(path, { seq: 2 });
    assert.deepEqual(readBoard(path), { seq: 2 });
    assert.deepEqual(readdirSync(dir), ['board.json']);
  }));

test('the save is readable only by the user', { skip: process.platform === 'win32' }, () =>
  inTemp((dir) => {
    const path = join(dir, 'board.json');
    writeBoard(path, {});
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }));

test('a missing or corrupt save reads as nothing', () =>
  inTemp((dir) => {
    assert.equal(readBoard(join(dir, 'nope.json')), null);
    writeFileSync(join(dir, 'bad.json'), '{"seq":');
    assert.equal(readBoard(join(dir, 'bad.json')), null);
  }));
