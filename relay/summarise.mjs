import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const TAIL_BYTES = 512 * 1024;
const KEEP_ITEMS = 40;
const ITEM_CHARS = 400;
const INPUT_CHARS = 8000;
const TIMEOUT_MS = 20000;

const SYSTEM = [
  'You write the one-line status shown for a coding agent on a TV dashboard.',
  'Read the recent conversation between a developer and their coding agent and say what the agent is doing right now.',
  'Rules: one line, at most 80 characters, present tense, start with a verb ending in -ing (e.g. "Wiring the history page to the sync API").',
  'If the agent has finished its turn, say where things stand instead (e.g. "Waiting for review after adding the thought bubble").',
  'Be specific about the feature or file, not generic ("Working on code"). No quotes, no trailing period, no preamble.',
].join(' ');

async function readTail(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally {
    await file.close();
  }
}

const squash = (text, n = ITEM_CHARS) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
};

function toolBrief(name, input = {}) {
  const detail = input.description ?? input.file_path ?? input.command ?? input.pattern ?? input.prompt ?? input.url ?? '';
  return `${name}${detail ? ` ${squash(detail, 120)}` : ''}`;
}

export function buildInput(lines) {
  const items = [];
  let title = null;
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) continue;
    const content = e.message?.content;
    if (e.type === 'user') {
      if (typeof content === 'string') items.push(`Developer: ${squash(content)}`);
      else if (Array.isArray(content)) for (const p of content) if (p.type === 'text') items.push(`Developer: ${squash(p.text)}`);
      continue;
    }
    for (const p of Array.isArray(content) ? content : []) {
      if (p.type === 'text' && p.text.trim()) items.push(`Agent: ${squash(p.text)}`);
      else if (p.type === 'tool_use') items.push(`Agent ran: ${toolBrief(p.name, p.input)}`);
    }
  }
  const recent = items.slice(-KEEP_ITEMS);
  let body = recent.join('\n');
  while (body.length > INPUT_CHARS && recent.length > 1) body = (recent.shift(), recent.join('\n'));
  return { title, body };
}

export function cleanLine(text) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const bare = line.replace(/^["'“]|["'”]$/g, '').replace(/\.$/, '').trim();
  return bare.length > 90 ? bare.slice(0, 89) + '…' : bare;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project', '--system-prompt', SYSTEM],
      { cwd: tmpdir(), env: { ...process.env, TALLY_DISABLE: '1' }, windowsHide: true },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('timed out'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}`));
    });
    child.stdin.end(prompt);
  });
}

export async function summarise({ project, transcriptPath }, run = runClaude) {
  const { title, body } = buildInput(await readTail(transcriptPath));
  if (!body) return null;
  const header = `Project: ${project}${title ? `\nSession title: ${title}` : ''}`;
  const line = cleanLine(await run(`${header}\n\nRecent conversation (oldest first):\n${body}`));
  return line || null;
}
