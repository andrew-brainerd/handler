import { open } from 'node:fs/promises';

const TAIL_BYTES = 256 * 1024;
const DENIED = "doesn't want to proceed";
const INTERRUPTED = '[Request interrupted by user';

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

const textOf = (part) => (typeof part === 'string' ? part : typeof part?.content === 'string' ? part.content : Array.isArray(part?.content) ? part.content.map(textOf).join(' ') : (part?.text ?? ''));

export function findOutcome(lines, { toolUseIds = [], since = 0, until = Infinity }) {
  const wanted = new Set(toolUseIds);
  const results = {};
  let interrupted = false;
  for (const line of lines) {
    const mentionsId = wanted.size > 0 && line.includes('tool_result') && [...wanted].some((id) => line.includes(id));
    if (!mentionsId && !line.includes(INTERRUPTED)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user') continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : null;
    if (at !== null && at > until) continue;
    const content = entry.message?.content;
    for (const part of Array.isArray(content) ? content : [content]) {
      const text = textOf(part);
      if (part?.type === 'tool_result' && wanted.has(part.tool_use_id)) results[part.tool_use_id] = text.includes(DENIED) ? 'denied' : 'done';
      else if (text.trimStart().startsWith(INTERRUPTED) && (at === null || at >= since)) interrupted = true;
    }
  }
  return { results, interrupted };
}

export const hasOutcome = ({ results, interrupted }) => interrupted || Object.keys(results).length > 0;

export async function checkTranscript(target) {
  try {
    return findOutcome(await readTail(target.path), target);
  } catch {
    return { results: {}, interrupted: false };
  }
}
