import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../relay/state.mjs';
import { buildInput, cleanLine, summarise } from '../relay/summarise.mjs';

const SID = 'sess-1';
const base = { session_id: SID, cwd: 'C:\\projects\\handler', transcript_path: 'C:\\t\\sess-1.jsonl' };

function board() {
  const b = new Board();
  let now = 1_000_000;
  const apply = (e, wait = 1000) => b.apply({ ...base, ...e }, (now += wait));
  return { b, apply, at: () => now };
}

test('tool use asks for a summary at most once a minute; stop asks right away', () => {
  const { b, apply, at } = board();
  apply({ hook_event_name: 'UserPromptSubmit', prompt: 'add summaries' });
  assert.equal(b.nextSummary(at()), null);
  apply({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1' });
  assert.equal(b.nextSummary(at()).sessionId, SID);
  apply({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2' }, 10_000);
  assert.equal(b.nextSummary(at()), null);
  assert.equal(b.nextSummary(at() + 60_000).sessionId, SID);
  apply({ hook_event_name: 'Stop' }, 61_000 + 5_000);
  assert.ok(b.nextSummary(at()));
  assert.equal(b.nextSummary(at()), null);
});

test('a summary shows on the card and a new prompt clears it and drops late results', () => {
  const { b, apply, at } = board();
  apply({ hook_event_name: 'UserPromptSubmit', prompt: 'add summaries' });
  apply({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1' });
  const job = b.nextSummary(at());
  assert.ok(b.setSummary(job, 'Wiring Haiku summaries into the relay'));
  const card = () => b.snapshot(at()).sessions[0];
  assert.equal(card().summary, 'Wiring Haiku summaries into the relay');
  assert.equal(card().summarySource, 'summary');
  apply({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2' }, 61_000);
  const late = b.nextSummary(at());
  apply({ hook_event_name: 'UserPromptSubmit', prompt: 'now the roku channel' });
  assert.equal(b.setSummary(late, 'Stale line'), false);
  assert.equal(card().summary, 'now the roku channel');
});

test('buildInput keeps prompts, agent text and tool briefs, skipping results and meta', () => {
  const lines = [
    { type: 'ai-title', aiTitle: 'Roku status board' },
    { type: 'user', message: { content: 'add a thought bubble' } },
    { type: 'user', isMeta: true, message: { content: 'caveat' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Adding it now.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/p/index.html' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  ].map((e) => JSON.stringify(e));
  const { title, body } = buildInput(['not json', ...lines]);
  assert.equal(title, 'Roku status board');
  assert.equal(body, 'Developer: add a thought bubble\nAgent: Adding it now.\nAgent ran: Edit C:/p/index.html');
});

test('cleanLine takes the first line and strips quotes and the full stop', () => {
  assert.equal(cleanLine('\n"Adding the bubble."\nextra'), 'Adding the bubble');
});

test('summarise feeds the transcript to the model and returns its line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'));
  const path = join(dir, 't.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', message: { content: 'ship it' } }) + '\n');
  let prompt = null;
  const line = await summarise({ project: 'handler', transcriptPath: path }, async (p) => ((prompt = p), 'Shipping it.\n'));
  assert.equal(line, 'Shipping it');
  assert.match(prompt, /Project: handler/);
  assert.match(prompt, /Developer: ship it/);
});
