import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isQuiet, parseQuiet } from '../relay/quiet.mjs';

const at = (h, m = 0) => new Date(2026, 10, 1, h, m);

test('empty quiet hours mean never quiet', () => {
  assert.equal(parseQuiet(''), null);
  assert.equal(isQuiet(parseQuiet(undefined), at(3)), false);
});

test('an overnight range wraps past midnight', () => {
  const q = parseQuiet('22:00-07:30');
  assert.equal(isQuiet(q, at(21, 59)), false);
  assert.equal(isQuiet(q, at(22)), true);
  assert.equal(isQuiet(q, at(3)), true);
  assert.equal(isQuiet(q, at(7, 29)), true);
  assert.equal(isQuiet(q, at(7, 30)), false);
});

test('a daytime range does not wrap', () => {
  const q = parseQuiet('12:00 - 13:00');
  assert.equal(isQuiet(q, at(12, 30)), true);
  assert.equal(isQuiet(q, at(13)), false);
});

test('bad ranges are rejected', () => {
  assert.throws(() => parseQuiet('22-7'));
  assert.throws(() => parseQuiet('25:00-07:00'));
  assert.throws(() => parseQuiet('08:00-08:00'));
});
