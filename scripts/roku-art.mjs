import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'roku', 'images');
const FOX = join(ROOT, 'characters', 'fox', 'still.png');

const C = { bg: '#0d0f12', card: '#171a1f', line: '#262a31', red: '#ff4d3d', amber: '#f2b33d', green: '#4fd18b', grey: '#5b6068', text: '#e8e6e1', dim: '#8b8f97', avatar: '#0f1216' };

const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
const png = (w, h, body) => sharp(svg(w, h, body)).png().toBuffer();

async function ninePatch(file, w, h, body, stretch) {
  const inner = await png(w, h, body);
  const marks = [
    { left: 1 + stretch.x0, top: 0, width: stretch.x1 - stretch.x0, height: 1 },
    { left: 0, top: 1 + stretch.y0, width: 1, height: stretch.y1 - stretch.y0 },
  ];
  const black = await Promise.all(marks.map((m) => sharp({ create: { width: m.width, height: m.height, channels: 4, background: '#000000ff' } }).png().toBuffer()));
  await sharp({ create: { width: w + 2, height: h + 2, channels: 4, background: '#00000000' } })
    .composite([{ input: inner, left: 1, top: 1 }, ...black.map((input, i) => ({ input, left: marks[i].left, top: marks[i].top }))])
    .png()
    .toFile(join(OUT, file));
}

async function cards() {
  const variants = { working: { accent: C.green }, waiting: { accent: C.amber }, dim: { accent: C.grey }, alert: { accent: C.red, border: '#ff4d3dcc' } };
  for (const [name, v] of Object.entries(variants)) {
    const w = 96;
    const h = 96;
    const body = `<defs><clipPath id="c"><rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="20"/></clipPath></defs>
      <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="20" fill="${C.card}" stroke="${v.border ?? C.line}" stroke-width="2"/>
      <rect x="0" y="0" width="8" height="${h}" fill="${v.accent}" clip-path="url(#c)"/>`;
    await ninePatch(`card-${name}.9.png`, w, h, body, { x0: 32, x1: 64, y0: 32, y1: 64 });
  }
  const focus = `<rect x="2" y="2" width="92" height="92" rx="20" fill="none" stroke="${C.text}" stroke-width="4"/>`;
  await ninePatch('card-focus.9.png', 96, 96, focus, { x0: 32, x1: 64, y0: 32, y1: 64 });
}

async function avatarFrames() {
  for (const [name, color] of Object.entries({ working: C.green, waiting: C.amber, dim: C.grey, alert: C.red })) {
    const w = 72;
    const body = `<rect x="2" y="2" width="${w - 4}" height="${w - 4}" rx="18" fill="${C.avatar}" stroke="${color}" stroke-width="4"/>`;
    await ninePatch(`avatar-${name}.9.png`, w, w, body, { x0: 24, x1: 48, y0: 24, y1: 48 });
  }
}

async function bubbles() {
  for (const [name, mark] of Object.entries({ question: '?', permission: '!' })) {
    const body = `<g fill="#f4f1ea" stroke="#14171c" stroke-width="3">
        <circle cx="10" cy="50" r="4"/><circle cx="19" cy="40" r="6"/>
        <ellipse cx="38" cy="24" rx="21" ry="19"/></g>
      <text x="38" y="34" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="800" font-size="28" fill="#14171c">${mark}</text>`;
    writeFileSync(join(OUT, `bubble-${name}.png`), await png(64, 60, body));
  }
}

async function lamps() {
  writeFileSync(join(OUT, 'lamp-grey.png'), await png(48, 48, `<circle cx="24" cy="24" r="11" fill="${C.grey}"/><circle cx="24" cy="24" r="14" fill="none" stroke="#ffffff10" stroke-width="4"/>`));
  writeFileSync(
    join(OUT, 'lamp-red.png'),
    await png(48, 48, `<defs><radialGradient id="g"><stop offset="0.45" stop-color="${C.red}" stop-opacity="0.8"/><stop offset="1" stop-color="${C.red}" stop-opacity="0"/></radialGradient></defs><circle cx="24" cy="24" r="24" fill="url(#g)"/><circle cx="24" cy="24" r="11" fill="${C.red}"/>`),
  );
  writeFileSync(
    join(OUT, 'dot-amber.png'),
    await png(40, 40, `<defs><radialGradient id="g"><stop offset="0.5" stop-color="${C.amber}" stop-opacity="0.7"/><stop offset="1" stop-color="${C.amber}" stop-opacity="0"/></radialGradient></defs><circle cx="20" cy="20" r="20" fill="url(#g)"/><circle cx="20" cy="20" r="10" fill="${C.amber}"/>`),
  );
}

async function banner() {
  const h = 88;
  const w = 200;
  const body = `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${(h - 2) / 2}" fill="#232a33" stroke="#3a4350" stroke-width="2"/>`;
  await ninePatch('banner.9.png', w, h, body, { x0: 60, x1: 140, y0: 40, y1: 48 });
}

async function brand(w, h, file, scale) {
  const head = Math.round(h * 0.42);
  const fox = await sharp(FOX).resize(head, head, { kernel: 'nearest' }).png().toBuffer();
  const text = `<text x="${w / 2}" y="${h * 0.78}" text-anchor="middle" font-family="Segoe UI, Arial" font-weight="700" font-size="${Math.round(h * 0.16 * scale)}" fill="${C.text}">Tally</text>`;
  await sharp(svg(w, h, `<rect width="${w}" height="${h}" fill="${C.bg}"/>${text}`))
    .composite([{ input: fox, left: Math.round((w - head) / 2), top: Math.round(h * 0.12) }])
    .png()
    .toFile(join(OUT, file));
}

function chime() {
  const rate = 44100;
  const notes = [
    [880, 0],
    [1320, 0.18],
  ];
  const length = Math.round(rate * 0.8);
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    let v = 0;
    for (const [f, start] of notes) {
      const dt = t - start;
      if (dt < 0 || dt > 0.55) continue;
      const env = Math.min(1, dt / 0.02) * Math.exp(-dt * 7);
      v += Math.sin(2 * Math.PI * f * dt) * env * 0.35;
    }
    samples[i] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const wav = join(tmpdir(), 'tally-chime.wav');
  writeFileSync(wav, Buffer.concat([header, data]));
  mkdirSync(join(ROOT, 'roku', 'sounds'), { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '128k', join(ROOT, 'roku', 'sounds', 'chime.m4a')]);
  rmSync(wav);
}

mkdirSync(OUT, { recursive: true });
await cards();
await avatarFrames();
await bubbles();
await lamps();
await banner();
await brand(540, 405, 'icon_fhd.png', 1);
await brand(290, 218, 'icon_hd.png', 1);
await brand(1920, 1080, 'splash_fhd.png', 0.7);
await brand(1280, 720, 'splash_hd.png', 0.7);
chime();
console.log('roku art written to roku/images and roku/sounds');
