import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export function readBoard(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeBoard(path, data) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  renameSync(temp, path);
}
