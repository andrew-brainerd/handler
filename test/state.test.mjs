import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, describeTool } from '../relay/state.mjs';
import { findOutcome } from '../relay/transcript.mjs';

const SID = 'sess-1';
const base = { session_id: SID, cwd: 'C:\\projects\\condensate', transcript_path: 'C:\\t\\sess-1.jsonl' };

function run(events) {
  const board = new Board();
  let now = 1_000_000;
  for (const e of events) {
    now += e.wait ?? 1000;
    board.apply({ ...base, ...e }, now);
  }
  return { board, now, card: () => board.snapshot(now).sessions.find((s) => s.id === SID) };
}

test('a session is hidden until it does something', () => {
  const { board, now } = run([
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'SessionEnd', reason: 'other' },
  ]);
  assert.equal(board.snapshot(now).sessions.length, 0);
});

test('prompt → working → stop → waiting, with project from cwd', () => {
  const { card } = run([
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'what feature should we work on next?' },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls', description: 'List files' } },
  ]);
  assert.equal(card().state, 'working');
  assert.equal(card().project, 'condensate');
  assert.deepEqual(card().activity, ['Bash: List files']);
  assert.equal(card().summary, 'what feature should we work on next?');
});

test('AskUserQuestion shows as asking with the question, clears when answered', () => {
  const { board, now, card } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'scope it' },
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'q1',
      tool_input: { questions: [{ question: 'Whose games?', options: [{ label: 'Friends' }, { label: 'Everyone' }] }] },
    },
    { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: {} },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
  ]);
  assert.equal(card().state, 'asking');
  assert.equal(card().needsYou, true);
  assert.deepEqual(card().question, { text: 'Whose games?', options: ['Friends', 'Everyone'] });
  board.apply({ ...base, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1' }, now + 1000);
  const after = board.snapshot(now + 1000).sessions[0];
  assert.equal(after.state, 'working');
  assert.equal(after.question, null);
});

test('permission prompt, then a deny found in the transcript', () => {
  const { board, now, card } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'add a line' },
    { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_use_id: 'p1', tool_input: { command: 'Add-Content README.md' } },
    { hook_event_name: 'PermissionRequest', tool_name: 'PowerShell', tool_input: { command: 'Add-Content README.md' } },
  ]);
  assert.equal(card().state, 'needs_permission');
  assert.equal(card().detail, 'Needs permission: PowerShell: Add-Content README.md');
  const [target] = board.watchTargets(now);
  assert.deepEqual(target.toolUseIds, ['p1']);
  assert.equal(target.path, 'C:\\t\\sess-1.jsonl');
  board.resolve(target.sessionId, target.agentKey, { results: { p1: 'denied' }, interrupted: true }, now + 500);
  assert.equal(board.snapshot(now + 500).sessions[0].state, 'waiting');
  assert.equal(board.snapshot(now + 500).sessions[0].detail, 'You said no');
  assert.equal(board.watchTargets(now + 500).length, 0);
});

test('a subagent waiting on permission makes a stopped session red', () => {
  const { card } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'build the nav bar' },
    { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'a1', tool_input: { description: 'Nav bar', run_in_background: true } },
    { hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'general-purpose' },
    { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'a1' },
    { hook_event_name: 'PreToolUse', agent_id: 'ag1', agent_type: 'general-purpose', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'cargo test' } },
    { hook_event_name: 'PermissionRequest', agent_id: 'ag1', agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'cargo test' } },
    {
      hook_event_name: 'Stop',
      last_assistant_message: 'Started an agent.',
      background_tasks: [{ id: 'ag1', type: 'subagent', status: 'running', description: 'Nav bar', agent_type: 'general-purpose' }],
    },
    { hook_event_name: 'SubagentStop', agent_id: 'phantom', agent_type: '', last_assistant_message: 'push it too' },
  ]);
  assert.equal(card().state, 'needs_permission');
  assert.equal(card().detail, 'Needs permission: Bash: cargo test (general-purpose)');
  assert.equal(card().subagents, 1);
  assert.deepEqual(card().activity.slice(0, 2), ['↳ Bash: cargo test', 'Agent: Nav bar']);
});

test('subagent prompt resolves when the subagent carries on; finishing removes it', () => {
  const { board, now } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
    { hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore' },
    { hook_event_name: 'PreToolUse', agent_id: 'ag1', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'ls' } },
    { hook_event_name: 'PermissionRequest', agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: 'ls' } },
    { hook_event_name: 'PostToolUse', agent_id: 'ag1', tool_name: 'Bash', tool_use_id: 'b1' },
  ]);
  assert.equal(board.snapshot(now).sessions[0].state, 'working');
  board.apply({ ...base, hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'Explore' }, now + 1000);
  board.apply({ ...base, hook_event_name: 'Stop', background_tasks: [] }, now + 2000);
  const card = board.snapshot(now + 2000).sessions[0];
  assert.equal(card.state, 'waiting');
  assert.equal(card.subagents, 0);
});

test('idle notification clears a stale fallback prompt', () => {
  const { card } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
  ]);
  assert.equal(card().state, 'waiting');
});

test('exit then resume brings the card back', () => {
  const { board, now } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
  ]);
  assert.equal(board.snapshot(now).sessions[0].state, 'ended');
  board.apply({ ...base, hook_event_name: 'SessionStart', source: 'resume' }, now + 5000);
  assert.equal(board.snapshot(now + 5000).sessions[0].state, 'waiting');
});

test('ended cards drop after two minutes; working goes stale after 30', () => {
  const { board, now } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'sleep' } },
  ]);
  assert.equal(board.snapshot(now + 31 * 60e3).sessions[0].state, 'stale');
  board.apply({ ...base, hook_event_name: 'SessionEnd' }, now + 1000);
  board.sweep(now + 1000 + 3 * 60e3);
  assert.equal(board.sessions.size, 0);
});

test('forked session does not double-count the parent background agent', () => {
  const board = new Board();
  board.apply({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x' }, 1);
  board.apply({ ...base, hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'general-purpose' }, 2);
  board.apply({ ...base, session_id: 'fork', hook_event_name: 'SessionStart', source: 'fork' }, 3);
  board.apply({ ...base, session_id: 'fork', hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'general-purpose' }, 4);
  assert.equal(board.sessions.get('fork').agents.size, 1);
});

test('needs-you cards sort first, oldest wait first', () => {
  const board = new Board();
  const ev = (sid, e, t) => board.apply({ ...base, session_id: sid, ...e }, t);
  ev('a', { hook_event_name: 'UserPromptSubmit', prompt: 'a' }, 1000);
  ev('b', { hook_event_name: 'UserPromptSubmit', prompt: 'b' }, 1000);
  ev('c', { hook_event_name: 'UserPromptSubmit', prompt: 'c' }, 1000);
  ev('b', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'b' } }, 2000);
  ev('b', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'b' } }, 2000);
  ev('c', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'y', tool_input: { command: 'c' } }, 3000);
  ev('c', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'c' } }, 3000);
  ev('a', { hook_event_name: 'Stop' }, 4000);
  assert.deepEqual(board.snapshot(5000).sessions.map((s) => s.id), ['b', 'c', 'a']);
});

test('TodoWrite gives the current item and progress', () => {
  const { card } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'x' },
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'TodoWrite',
      tool_use_id: 't',
      tool_input: {
        todos: [
          { content: 'A', status: 'completed', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
          { content: 'C', status: 'pending', activeForm: 'Doing C' },
        ],
      },
    },
  ]);
  assert.deepEqual(card().todo, { current: 'Doing B', done: 1, total: 3 });
  assert.equal(card().summary, 'Doing B');
});

test('tool descriptions', () => {
  assert.equal(describeTool('Edit', { file_path: 'C:\\projects\\x\\server.mjs' }), 'Edit server.mjs');
  assert.equal(describeTool('WebFetch', { url: 'https://dev.twitch.tv/docs' }), 'WebFetch dev.twitch.tv');
  assert.equal(describeTool('mcp__claude-in-chrome__navigate', {}), 'claude-in-chrome: navigate');
});

test('transcript: deny and interrupt detection', () => {
  const line = (o) => JSON.stringify(o);
  const denied = [
    line({ type: 'assistant', timestamp: '2026-10-30T21:58:15.249Z', message: { content: [{ type: 'tool_use', id: 'p1' }] } }),
    line({
      type: 'user',
      timestamp: '2026-10-30T21:58:17.375Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'p1', is_error: true, content: "The user doesn't want to proceed with this tool use." }] },
    }),
    line({ type: 'user', timestamp: '2026-10-30T21:58:17.376Z', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
  ];
  const since = Date.parse('2026-10-30T21:58:14Z');
  assert.deepEqual(findOutcome(denied, { toolUseIds: ['p1'], since }), { results: { p1: 'denied' }, interrupted: true });
  assert.deepEqual(findOutcome(denied, { toolUseIds: [], since }), { results: {}, interrupted: true });
  assert.deepEqual(findOutcome(denied, { toolUseIds: ['p1'], since, until: Date.parse('2026-10-30T21:58:16Z') }), { results: {}, interrupted: false });
  const esc = [line({ type: 'user', timestamp: '2026-10-30T22:00:01Z', message: { content: '[Request interrupted by user]' } })];
  assert.equal(findOutcome(esc, { since }).interrupted, true);
  assert.equal(findOutcome(esc, { since: Date.parse('2026-10-30T22:01:00Z') }).interrupted, false);
  const dismissed = [
    line({
      type: 'user',
      timestamp: '2026-10-30T21:51:18Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'GitKraken Desktop dismissed this permission request because a newer request superseded it' }] },
    }),
  ];
  assert.deepEqual(findOutcome(dismissed, { toolUseIds: ['b2'], since }).results, { b2: 'done' });
});

test('parallel tool calls: a second call does not clear the first prompt', () => {
  const { board, now, card } = run([
    { hook_event_name: 'UserPromptSubmit', prompt: 'research' },
    { hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_use_id: 'f1', tool_input: { url: 'https://dev.twitch.tv/x' } },
    { hook_event_name: 'PermissionRequest', tool_name: 'WebFetch', tool_input: { url: 'https://dev.twitch.tv/x' } },
    { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_use_id: 's1', tool_input: { query: 'q' } },
    { hook_event_name: 'PermissionRequest', tool_name: 'WebSearch', tool_input: { query: 'q' } },
    { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' } },
    { hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_use_id: 'g1' },
    { hook_event_name: 'PostToolUse', tool_name: 'WebSearch', tool_use_id: 's1' },
  ]);
  assert.equal(card().state, 'needs_permission');
  assert.equal(card().detail, 'Needs permission: WebFetch dev.twitch.tv');
  board.resolve(SID, 'main', { results: { f1: 'done' } }, now + 100);
  assert.equal(board.snapshot(now + 100).sessions[0].state, 'working');
});
