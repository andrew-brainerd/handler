import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const API = 'https://api.pixellab.ai/v2';
const ROOT = join(import.meta.dirname, '..', 'characters');
const TV = { scale: 2, cols: 8 };

const STYLE = 'chibi anime style, cel-shaded with flat colors and two-tone hard-edged shadows, clean bold lines, vibrant saturated palette';

const KINDS = {
  head: {
    describe: (subject) => `chibi ${subject} head, ${STYLE}, oversized round head, huge sparkly anime eyes taking up much of the face with big white highlights, tiny mouth, small muzzle, rosy blush cheeks, soft rounded shapes, kawaii, front view looking straight at the viewer, head only, centered`,
    expressions: {
      working: { action: 'excited to get attention: ears perk up, eyebrows raise, eyes go wide, mouth opens as if calling out', frames: 8, fps: 10, loop: true },
      puzzled: { action: 'puzzled: head tilts to one side, one eyebrow raises, a small unsure frown', frames: 8, fps: 8, loop: false },
      bored: { action: 'bored and unimpressed, eyes stay open the whole time: flat half-lidded stare, eyes roll up and to the side, mouth pulls into a flat sideways frown, a slow sigh', frames: 8, fps: 6, loop: true, pingpong: true },
      sleepy: { action: 'getting sleepy: eyelids droop, a big yawn, eyes close and the head nods down asleep', frames: 8, fps: 6, loop: false },
      sleeping: { from: 'sleepy', action: 'fast asleep with eyes closed: slow breathing, the head gently rises and falls, a tiny ear twitch', frames: 8, fps: 5, loop: true, pingpong: true },
    },
  },
  slime: {
    describe: (subject) => `${subject}, retro 16-bit game monster sprite, clean bold lines, flat colors with two-tone hard-edged shading, one smooth rounded dome shape like a water balloon with a flat bottom, a single solid color, one glossy highlight, simple solid black oval eyes with one small white highlight, no eyelashes, no blush, small plain mouth, front view looking straight at the viewer, whole body, centered`,
    expressions: {
      working: { action: 'busy and bouncy: the slime squashes down and springs back up, eyes bright and focused, a small determined smile', frames: 8, fps: 10, loop: true },
      puzzled: { action: 'puzzled: the slime leans and tilts to one side, one eye squints, a small unsure frown, the body wobbles', frames: 8, fps: 8, loop: false },
      bored: { action: 'bored and unimpressed, eyes stay open the whole time: flat half-lidded stare, the body slumps and spreads a little flatter, mouth pulls into a flat sideways frown, a slow sigh', frames: 8, fps: 6, loop: true, pingpong: true },
      sleepy: { action: 'getting sleepy: eyelids droop, a big yawn, the body sags and melts lower, eyes close', frames: 8, fps: 6, loop: false },
      sleeping: { from: 'sleepy', action: 'fast asleep with eyes closed: slow breathing, the body gently swells and settles', frames: 8, fps: 5, loop: true, pingpong: true },
    },
  },
};
const kindOf = (meta) => KINDS[meta.kind ?? 'head'];

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    subject: { type: 'string' },
    kind: { type: 'string' },
    size: { type: 'string', default: '64' },
    only: { type: 'string' },
    redo: { type: 'boolean', default: false },
    seed: { type: 'string' },
    enhance: { type: 'boolean', default: false },
    outline: { type: 'string', default: 'single color black outline' },
    detail: { type: 'string', default: 'medium detail' },
  },
});

const key = process.env.PIXEL_LAB_API_KEY;
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  if (!key) throw new Error('PIXEL_LAB_API_KEY is not set (run under infisical run)');
  let res, text;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
    if (res.status !== 429 || attempt >= 40) break;
    await sleep(15000);
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function waitForJob(id, label) {
  const started = Date.now();
  for (;;) {
    const job = await api('GET', `/background-jobs/${id}`);
    if (job.status === 'completed') {
      log(`${label}: done in ${Math.round((Date.now() - started) / 1000)}s`, job.usage ? JSON.stringify(job.usage) : '');
      return job;
    }
    if (job.status === 'failed') throw new Error(`${label} failed: ${JSON.stringify(job.last_response).slice(0, 500)}`);
    if (Date.now() - started > 15 * 60e3) throw new Error(`${label} timed out`);
    await sleep(4000);
  }
}

const dirOf = (id) => join(ROOT, id);
const rawDir = (id) => join(dirOf(id), 'raw');
const metaPath = (id) => join(dirOf(id), 'pixellab.json');
const loadMeta = (id) => (existsSync(metaPath(id)) ? JSON.parse(readFileSync(metaPath(id), 'utf8')) : { expressions: {} });
const saveMeta = (id, meta) => writeFileSync(metaPath(id), JSON.stringify(meta, null, 2) + '\n');
const imageBytes = (img) => Buffer.from(img.base64 ?? img, 'base64');

async function balance() {
  const b = await api('GET', '/balance');
  log('balance', JSON.stringify(b.subscription ?? b));
}

async function create(id) {
  const meta = loadMeta(id);
  if (existsSync(join(rawDir(id), 'base.png')) && !args.redo) return log(`${id}: base image exists (use --redo to replace)`);
  const subject = args.subject ?? meta.subject ?? meta.animal;
  if (!subject) throw new Error('--subject is required');
  const kind = args.kind ?? meta.kind ?? 'head';
  if (!KINDS[kind]) throw new Error(`unknown --kind ${kind}`);
  mkdirSync(rawDir(id), { recursive: true });
  const size = Number(args.size);
  const res = await api('POST', '/create-image-pixen', {
    description: KINDS[kind].describe(subject),
    image_size: { width: size, height: size },
    view: 'side',
    direction: 'south',
    outline: args.outline,
    detail: args.detail,
    no_background: true,
    ...(args.seed ? { seed: Number(args.seed) } : {}),
    ...(args.enhance ? { enhance_prompt: true } : {}),
  });
  writeFileSync(join(rawDir(id), 'base.png'), imageBytes(res.image));
  Object.assign(meta, { subject, kind, size, expressions: args.redo ? {} : meta.expressions });
  saveMeta(id, meta);
  log(`${id}: base ${kind} (${subject})`, res.usage ? JSON.stringify(res.usage) : '');
}

async function animate(id) {
  const meta = loadMeta(id);
  const EXPRESSIONS = kindOf(meta).expressions;
  const wanted = args.only ? args.only.split(',') : Object.keys(EXPRESSIONS);
  const firstFrame = (spec) => {
    if (!spec.from) return readFileSync(join(rawDir(id), 'base.png')).toString('base64');
    const frames = readdirSync(rawDir(id)).filter((f) => f.startsWith(`${spec.from}-`)).sort();
    if (!frames.length) throw new Error(`${id}: animate ${spec.from} first`);
    return readFileSync(join(rawDir(id), frames.at(-1))).toString('base64');
  };
  const run = (names) => Promise.all(
    names.map(async (name) => {
      if (meta.expressions[name] && !(args.redo && args.only)) return log(`${id}/${name}: already animated`);
      const spec = EXPRESSIONS[name];
      const res = await api('POST', '/animate-with-text-v3', {
        first_frame: { type: 'base64', base64: firstFrame(spec) },
        action: spec.action,
        frame_count: spec.frames,
        no_background: true,
      });
      log(`${id}/${name}: job ${res.background_job_id}`, res.usage ? JSON.stringify(res.usage) : '');
      const job = await waitForJob(res.background_job_id, `${id}/${name}`);
      const images = job.last_response?.images ?? [];
      if (!images.length) throw new Error(`${id}/${name}: no frames in ${JSON.stringify(job.last_response).slice(0, 300)}`);
      images.forEach((img, i) => writeFileSync(join(rawDir(id), `${name}-${String(i).padStart(2, '0')}.png`), imageBytes(img)));
      meta.expressions[name] = { frames: images.length, at: new Date().toISOString() };
      saveMeta(id, meta);
    }),
  );
  await run(wanted.filter((n) => !EXPRESSIONS[n].from));
  await run(wanted.filter((n) => EXPRESSIONS[n].from));
}

async function exportHead(id) {
  const meta = loadMeta(id);
  const EXPRESSIONS = kindOf(meta).expressions;
  const files = readdirSync(rawDir(id));
  const strips = {};
  for (const name of Object.keys(meta.expressions).filter((n) => EXPRESSIONS[n])) strips[name] = files.filter((f) => f.startsWith(`${name}-`)).sort().map((f) => readFileSync(join(rawDir(id), f)));
  const base = readFileSync(join(rawDir(id), 'base.png'));
  const everything = [base, ...Object.values(strips).flat()];

  const sizes = await Promise.all(everything.map((f) => sharp(f).metadata()));
  const cell = { w: Math.max(...sizes.map((m) => m.width)), h: Math.max(...sizes.map((m) => m.height)) };
  const clear = { r: 0, g: 0, b: 0, alpha: 0 };
  const centred = async (input) => {
    const m = await sharp(input).metadata();
    const left = Math.floor((cell.w - m.width) / 2);
    const top = Math.floor((cell.h - m.height) / 2);
    return sharp(input).ensureAlpha().extend({ left, right: cell.w - m.width - left, top, bottom: cell.h - m.height - top, background: clear }).png().toBuffer();
  };

  let box = { x0: cell.w, y0: cell.h, x1: 0, y1: 0 };
  for (const frame of everything) {
    const { data } = await sharp(await centred(frame)).raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < cell.h; y++)
      for (let x = 0; x < cell.w; x++)
        if (data[(y * cell.w + x) * 4 + 3] > 0) box = { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
  }
  const side = Math.min(Math.max(box.x1 - box.x0, box.y1 - box.y0) + 3, cell.w, cell.h);
  const crop = {
    left: Math.max(0, Math.min(cell.w - side, Math.floor((box.x0 + box.x1 - side) / 2))),
    top: Math.max(0, Math.min(cell.h - side, Math.floor((box.y0 + box.y1 - side) / 2))),
    width: side,
    height: side,
  };
  const tight = async (frame) => sharp(await centred(frame)).extract(crop).png().toBuffer();
  log(`${id}: frame sizes ${[...new Set(sizes.map((m) => `${m.width}x${m.height}`))].join(', ')} → ${side}x${side}`);

  const tvSide = side * TV.scale;
  const tvGrid = async (cells, file) => {
    const big = await Promise.all(cells.map((c) => sharp(c).resize(tvSide, tvSide, { kernel: 'nearest' }).png().toBuffer()));
    const cols = Math.min(TV.cols, big.length);
    await sharp({ create: { width: tvSide * cols, height: tvSide * Math.ceil(big.length / TV.cols), channels: 4, background: clear } })
      .composite(big.map((input, i) => ({ input, left: (i % TV.cols) * tvSide, top: Math.floor(i / TV.cols) * tvSide })))
      .png()
      .toFile(join(dirOf(id), file));
  };

  const out = { id, name: meta.subject ?? meta.animal, kind: meta.kind ?? 'head', frame: { w: side, h: side }, still: 'still.png', tv: { frame: tvSide, cols: TV.cols, still: 'still-tv.png' }, states: {} };
  const still = await tight(base);
  writeFileSync(join(dirOf(id), 'still.png'), still);
  await tvGrid([still], 'still-tv.png');
  for (const [name, frames] of Object.entries(strips)) {
    const spec = EXPRESSIONS[name];
    const played = spec?.pingpong ? [...frames, ...frames.slice(1, -1).reverse()] : frames;
    const cells = await Promise.all(played.map(tight));
    await sharp({ create: { width: side * cells.length, height: side, channels: 4, background: clear } })
      .composite(cells.map((input, i) => ({ input, left: i * side, top: 0 })))
      .png()
      .toFile(join(dirOf(id), `${name}.png`));
    await tvGrid(cells, `${name}-tv.png`);
    out.states[name] = { file: `${name}.png`, tv: `${name}-tv.png`, frames: cells.length, fps: spec?.fps ?? 8, loop: spec?.loop ?? true };
  }
  writeFileSync(join(dirOf(id), 'character.json'), JSON.stringify(out, null, 2) + '\n');
  log(`${id}: exported ${Object.keys(out.states).join(', ')}`);
}

const [command, id] = positionals;
const commands = {
  balance,
  create: () => create(id),
  animate: () => animate(id),
  export: () => exportHead(id),
  all: async () => {
    await balance();
    await create(id);
    await animate(id);
    await exportHead(id);
    await balance();
  },
};

if (!commands[command] || (command !== 'balance' && !id)) {
  console.error('usage: node scripts/characters.mjs balance | create|animate|export|all <id> [--subject "red fox"] [--kind head|slime] [--size 64] [--only working,stale] [--redo] [--seed n]');
  process.exit(1);
}
await commands[command]();
