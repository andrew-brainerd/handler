import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const API = 'https://api.pixellab.ai/v2';
const ROOT = join(import.meta.dirname, '..', 'characters');
const DIRECTION = 'south';

const STATES = {
  working: { action: 'busily typing on a keyboard, head bobbing, focused and productive', fps: 10, loop: true },
  needs_you: { action: 'waving one arm high above the head to get attention, bouncing slightly', fps: 10, loop: true },
  waiting: { template: 'breathing-idle', fps: 6, loop: true },
  stale: { action: 'sitting down on the ground and dozing off asleep', fps: 6, loop: false },
  shrug: { action: 'shrugging both shoulders with palms turned up', fps: 8, loop: false },
};

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: 'string' },
    size: { type: 'string', default: '64' },
    states: { type: 'string' },
    seed: { type: 'string' },
  },
});

const key = process.env.PIXEL_LAB_API_KEY;
if (!key) {
  console.error('PIXEL_LAB_API_KEY is not set (run under infisical run)');
  process.exit(1);
}

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
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
    await sleep(5000);
  }
}

const dirOf = (id) => join(ROOT, id);
const statePath = (id) => join(dirOf(id), 'pixellab.json');
const loadState = (id) => (existsSync(statePath(id)) ? JSON.parse(readFileSync(statePath(id), 'utf8')) : { animations: {} });
const saveState = (id, state) => writeFileSync(statePath(id), JSON.stringify(state, null, 2) + '\n');

async function balance() {
  const b = await api('GET', '/balance');
  log('balance', JSON.stringify(b));
  return b;
}

async function create(id) {
  if (!args.description) throw new Error('--description is required');
  mkdirSync(dirOf(id), { recursive: true });
  const state = loadState(id);
  if (state.characterId) return log(`${id}: already created as ${state.characterId}`);
  const size = Number(args.size);
  const res = await api('POST', '/create-character-v3', {
    description: args.description,
    name: id,
    image_size: { width: size, height: size },
    view: 'low top-down',
    no_background: true,
    ...(args.seed ? { seed: Number(args.seed) } : {}),
  });
  log(`${id}: create → character ${res.character_id}, job ${res.background_job_id}`, res.usage ? JSON.stringify(res.usage) : '');
  state.characterId = res.character_id;
  state.description = args.description;
  state.size = size;
  saveState(id, state);
  await waitForJob(res.background_job_id, `${id} create`);
}

async function animate(id) {
  const state = loadState(id);
  if (!state.characterId) throw new Error(`${id}: create it first`);
  const wanted = args.states ? args.states.split(',') : Object.keys(STATES);
  const jobs = [];
  for (const name of wanted) {
    if (state.animations[name]) {
      log(`${id}/${name}: already animated`);
      continue;
    }
    const spec = STATES[name];
    const body = spec.template
      ? { character_id: state.characterId, mode: 'template', template_animation_id: spec.template, animation_name: name, directions: [DIRECTION] }
      : { character_id: state.characterId, mode: 'v3', action_description: spec.action, animation_name: name, directions: [DIRECTION], frame_count: 8 };
    const res = await api('POST', '/characters/animations', body);
    log(`${id}/${name}: animate → group ${res.animation_group_id}, jobs ${res.background_job_ids?.join(',')}`, res.usage ? JSON.stringify(res.usage) : '');
    state.animations[name] = res.animation_group_id;
    saveState(id, state);
    for (const job of res.background_job_ids ?? []) jobs.push(waitForJob(job, `${id}/${name}`));
  }
  await Promise.all(jobs);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function exportCharacter(id) {
  const state = loadState(id);
  const character = await api('GET', `/characters/${state.characterId}`);
  if (character.status !== 'completed') throw new Error(`${id}: character status ${character.status}`);
  const still = await download(character.rotation_urls[DIRECTION]);
  const strips = {};
  for (const [name, groupId] of Object.entries(state.animations)) {
    const group = character.animations?.find((a) => a.animation_group_id === groupId);
    const dir = group?.directions?.find((d) => d.direction === DIRECTION);
    if (!dir?.frames?.length) {
      log(`${id}/${name}: no frames yet`);
      continue;
    }
    strips[name] = await Promise.all(dir.frames.map(download));
  }

  const sizes = await Promise.all([still, ...Object.values(strips).flat()].map((f) => sharp(f).metadata()));
  const frame = { w: Math.max(...sizes.map((m) => m.width)), h: Math.max(...sizes.map((m) => m.height)) };
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const centred = async (input) => {
    const m = await sharp(input).metadata();
    const left = Math.floor((frame.w - m.width) / 2);
    const top = Math.floor((frame.h - m.height) / 2);
    return sharp(input).extend({ left, right: frame.w - m.width - left, top, bottom: frame.h - m.height - top, background: transparent }).png().toBuffer();
  };
  const all = await Promise.all([still, ...Object.values(strips).flat()].map(centred));
  let box = { x0: frame.w, y0: frame.h, x1: 0, y1: 0 };
  for (const cell of all) {
    const { data } = await sharp(cell).raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < frame.h; y++)
      for (let x = 0; x < frame.w; x++)
        if (data[(y * frame.w + x) * 4 + 3] > 0) box = { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) };
  }
  const side = Math.min(Math.max(box.x1 - box.x0, box.y1 - box.y0) + 3, frame.w, frame.h);
  const crop = {
    left: Math.max(0, Math.min(frame.w - side, Math.floor((box.x0 + box.x1 - side) / 2))),
    top: Math.max(0, Math.min(frame.h - side, box.y1 + 2 - side)),
    width: side,
    height: side,
  };
  log(`${id}: frame sizes ${[...new Set(sizes.map((m) => `${m.width}x${m.height}`))].join(', ')} → cell ${frame.w}x${frame.h}, cropped to ${side}x${side}`);
  const tight = (cell) => sharp(cell).extract(crop).png().toBuffer();
  const cellFrame = { w: side, h: side };

  const out = { id, name: id, description: state.description, frame: cellFrame, still: 'still.png', states: {} };
  writeFileSync(join(dirOf(id), 'still.png'), await tight(await centred(still)));
  for (const [name, frames] of Object.entries(strips)) {
    const cells = await Promise.all(frames.map(async (f) => tight(await centred(f))));
    await sharp({ create: { width: side * cells.length, height: side, channels: 4, background: transparent } })
      .composite(cells.map((input, i) => ({ input, left: i * side, top: 0 })))
      .png()
      .toFile(join(dirOf(id), `${name}.png`));
    out.states[name] = { file: `${name}.png`, frames: cells.length, fps: STATES[name]?.fps ?? 8, loop: STATES[name]?.loop ?? true };
    log(`${id}/${name}: ${cells.length} frames → ${name}.png`);
  }
  writeFileSync(join(dirOf(id), 'character.json'), JSON.stringify(out, null, 2) + '\n');
}

const [command, id] = positionals;
const commands = {
  balance,
  create: () => create(id),
  animate: () => animate(id),
  export: () => exportCharacter(id),
  all: async () => {
    await balance();
    await create(id);
    await animate(id);
    await exportCharacter(id);
    await balance();
  },
};

if (!commands[command] || (command !== 'balance' && !id)) {
  console.error('usage: node scripts/characters.mjs balance | create|animate|export|all <id> [--description "..."] [--size 64] [--states a,b] [--seed n]');
  process.exit(1);
}
await commands[command]();
