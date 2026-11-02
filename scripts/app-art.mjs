import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const TRAY = join(ROOT, 'app', 'src-tauri', 'icons', 'tray');
const SOURCE = join(ROOT, 'build', 'app-icon.png');
const SIZE = 64;

const LAMPS = {
  off: '#5b6270',
  idle: '#8a93a3',
  working: '#3ecf8e',
  needs: '#f0524f',
};

function lamp(color, label = '') {
  const r = SIZE / 2;
  const text = label
    ? `<text x="${r}" y="${r + (label.length > 1 ? 13 : 15)}" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="700" font-size="${label.length > 1 ? 34 : 42}" fill="#ffffff">${label}</text>`
    : `<circle cx="${r}" cy="${r}" r="${r * 0.32}" fill="#ffffff" fill-opacity="0.35"/>`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><circle cx="${r}" cy="${r}" r="${r - 2}" fill="${color}" stroke="#0d0f12" stroke-width="3"/>${text}</svg>`,
  );
}

mkdirSync(TRAY, { recursive: true });
for (const name of ['off', 'idle', 'working']) await sharp(lamp(LAMPS[name])).png().toFile(join(TRAY, `${name}.png`));
for (let n = 1; n <= 9; n++) await sharp(lamp(LAMPS.needs, String(n))).png().toFile(join(TRAY, `needs-${n}.png`));
await sharp(lamp(LAMPS.needs, '9+')).png().toFile(join(TRAY, 'needs-many.png'));

const mascot = await sharp(join(ROOT, 'characters', 'slime-steel', 'still.png')).resize(704, 704, { kernel: 'nearest' }).png().toBuffer();
const plate = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect x="48" y="48" width="928" height="928" rx="200" fill="#161a20" stroke="#3ecf8e" stroke-width="24"/></svg>',
);
mkdirSync(join(ROOT, 'build'), { recursive: true });
writeFileSync(SOURCE, await sharp(plate).composite([{ input: mascot, left: 160, top: 176 }]).png().toBuffer());
console.log(`tray icons in ${TRAY}; app icon source ${SOURCE} (run: cd app && pnpm tauri icon ../build/app-icon.png)`);
