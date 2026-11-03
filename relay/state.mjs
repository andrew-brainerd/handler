import { basename } from 'node:path';
import { sortSessions } from './peers.mjs';

const URGENCY = { asking: 5, needs_permission: 5, working: 3, waiting: 2, stale: 1, ended: 0 };
const NEEDS_YOU = new Set(['asking', 'needs_permission']);
const STALE_MS = 30 * 60e3;
const ENDED_KEEP_MS = 2 * 60e3;
const IDLE_EXPIRE_MS = 4 * 3600e3;
const HIDDEN_EXPIRE_MS = 10 * 60e3;
const QUIET_WATCH_MS = 30e3;
const ACTIVITY_KEEP = 20;
const DONE = 'Done, waiting for you';
const SUMMARY_EVERY_MS = 60e3;
const LIVE_IDLE_AFTER_MS = 15e3;
const SAVE_VERSION = 1;

const OUTPUT_CHARS = 320;

const tail = (text, max) => {
  const flat = plain(text ?? '')?.replace(/\s+/g, ' ').trim() ?? '';
  return flat.length > max ? `…${flat.slice(1 - max)}` : flat;
};

export const clip = (text, max) => {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

const fileName = (p) => (typeof p === 'string' ? basename(p.replaceAll('\\', '/')) : '');
const isToolUseId = (id) => !id.startsWith('~');

export function describeTool(name, input = {}) {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${name} ${fileName(input.file_path ?? input.notebook_path)}`;
    case 'Bash':
    case 'PowerShell':
      return `${name}: ${clip(input.description || input.command, 40)}`;
    case 'Grep':
      return `Grep "${clip(input.pattern, 30)}"`;
    case 'Glob':
      return `Glob ${clip(input.pattern, 30)}`;
    case 'WebFetch':
      try {
        return `WebFetch ${new URL(input.url).host}`;
      } catch {
        return 'WebFetch';
      }
    case 'WebSearch':
      return `WebSearch "${clip(input.query, 30)}"`;
    case 'Agent':
    case 'Task':
      return `Agent: ${clip(input.description, 40)}`;
    case 'AskUserQuestion':
      return 'Asked a question';
    case 'TodoWrite':
      return 'Updated the task list';
    case 'SubagentHandback':
      return 'Reported back';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
  return mcp ? `${mcp[1]}: ${mcp[2]}` : (name ?? 'tool');
}

const tagText = (text, tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim() ?? null;

export function parseInjected(prompt) {
  if (typeof prompt !== 'string') return null;
  const head = prompt.trimStart();
  const agentMessage = /^<agent-message from="([^"]+)">/.exec(head);
  if (agentMessage) return { agentId: agentMessage[1], line: 'Subagent reported back' };
  if (head.startsWith('<task-notification>')) {
    const summary = tagText(head, 'summary');
    const isAgent = /^Agent "/.test(summary ?? '');
    return { agentId: isAgent ? tagText(head, 'task-id') : null, line: clip(summary ?? 'Background task finished', 60) };
  }
  return null;
}

export const plain = (markdown) =>
  typeof markdown === 'string'
    ? markdown
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*(#+|[-*]|\d+\.)\s+/gm, '')
    : null;

const keepLines = (text, max) => (typeof text === 'string' ? (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text).trim() : null);

function firstQuestion(input) {
  const q = input?.questions?.[0];
  if (!q) return null;
  return { text: clip(q.question, 200), options: (q.options ?? []).map((o) => clip(o.label, 40)) };
}

function newAgent(key, type = null, description = null) {
  return { key, type, description, base: 'waiting', detail: null, since: 0, open: new Map(), pending: new Map() };
}

function setBase(agent, base, now, detail = null) {
  if (agent.base !== base || agent.detail !== detail) agent.since = now;
  agent.base = base;
  agent.detail = detail;
}

function clearAll(agent) {
  agent.open.clear();
  agent.pending.clear();
}

function view(agent) {
  if (agent.pending.size === 0) return { state: agent.base, detail: agent.detail, question: null, since: agent.since };
  const prompts = [...agent.pending.values()];
  const asking = prompts.find((p) => p.question !== undefined);
  const first = asking ?? prompts.reduce((a, b) => (b.since < a.since ? b : a));
  return { state: asking ? 'asking' : 'needs_permission', detail: first.detail, question: asking?.question ?? null, since: first.since };
}

export class Board {
  sessions = new Map();
  seq = 0;
  firstSeen = new Set();

  constructor({ locate = (cwd) => ({ project: fileName(cwd), branch: null }), tabName = () => null, onNewEventType = () => {} } = {}) {
    this.locate = locate;
    this.tabName = tabName;
    this.onNewEventType = onNewEventType;
  }

  apply(e, now = Date.now()) {
    if (!e?.session_id || !e.hook_event_name) return false;
    if (!this.firstSeen.has(e.hook_event_name)) {
      this.firstSeen.add(e.hook_event_name);
      this.onNewEventType(e.hook_event_name, Object.keys(e));
    }
    let s = this.sessions.get(e.session_id);
    if (!s) {
      s = this.#newSession(e, now);
      this.sessions.set(e.session_id, s);
    }
    s.lastEvent = now;
    if (e.cwd && e.cwd !== s.cwd) {
      s.cwd = e.cwd;
      Object.assign(s, this.locate(e.cwd));
    }
    if (e.host) s.host = e.host;
    if (e.warp_session) s.warpSession = e.warp_session;
    if (e.transcript_path) s.transcriptPath = e.transcript_path;
    const handler = this.#handlers[e.hook_event_name];
    if (!handler) return false;
    handler(s, e, now);
    this.seq++;
    return true;
  }

  #newSession(e, now) {
    return {
      id: e.session_id,
      cwd: null,
      project: '?',
      branch: null,
      host: e.host ?? null,
      warpSession: null,
      model: null,
      transcriptPath: e.transcript_path ?? null,
      started: now,
      lastEvent: now,
      visible: false,
      ended: null,
      firstPrompt: null,
      lastPrompt: null,
      lastMessage: null,
      recentText: '',
      summary: null,
      summaryWanted: false,
      summaryNow: false,
      summaryAt: 0,
      turn: 0,
      todo: null,
      tasks: { done: 0, total: 0, current: null },
      activity: [],
      agents: new Map([['main', newAgent('main')]]),
    };
  }

  #agent(s, e) {
    if (!e.agent_id) return s.agents.get('main');
    let a = s.agents.get(e.agent_id);
    if (!a) {
      a = newAgent(e.agent_id, e.agent_type || null);
      s.agents.set(e.agent_id, a);
    }
    return a;
  }

  #activity(s, line, agent, now) {
    s.activity.unshift({ at: now, text: agent.key === 'main' ? line : `↳ ${line}` });
    s.activity.length = Math.min(s.activity.length, ACTIVITY_KEEP);
  }

  #agentElsewhere(sessionId, agentId) {
    for (const [id, other] of this.sessions) if (id !== sessionId && other.agents.has(agentId)) return true;
    return false;
  }

  #syncBackground(s, tasks, now) {
    if (!Array.isArray(tasks)) return;
    const running = new Map(tasks.filter((t) => t.type === 'subagent' && t.status === 'running').map((t) => [t.id, t]));
    for (const key of [...s.agents.keys()]) if (key !== 'main' && !running.has(key)) s.agents.delete(key);
    for (const [id, t] of running) {
      let a = s.agents.get(id);
      if (!a) {
        a = newAgent(id, t.agent_type);
        setBase(a, 'working', now);
        s.agents.set(id, a);
      }
      a.description = t.description ?? a.description;
    }
  }

  #handlers = {
    SessionStart: (s, e, now) => {
      s.model = e.model ?? s.model;
      if (e.source === 'resume' || s.ended) {
        s.ended = null;
        setBase(s.agents.get('main'), 'waiting', now);
      }
    },
    UserPromptSubmit: (s, e, now) => {
      s.visible = true;
      const main = s.agents.get('main');
      const injected = parseInjected(e.prompt);
      if (injected) {
        if (injected.agentId) s.agents.delete(injected.agentId);
        setBase(main, 'working', now);
        this.#activity(s, injected.line, main, now);
        return;
      }
      s.firstPrompt ??= clip(e.prompt, 120);
      s.lastPrompt = clip(e.prompt, 120);
      s.recentText = '';
      s.summary = null;
      s.summaryAt = 0;
      s.turn++;
      clearAll(main);
      setBase(main, 'working', now);
    },
    PreToolUse: (s, e, now) => {
      s.visible = true;
      const a = this.#agent(s, e);
      const id = e.tool_use_id ?? `~pre-${now}`;
      a.open.set(id, e.tool_name);
      setBase(a, 'working', now);
      if (e.tool_name === 'AskUserQuestion') a.pending.set(id, { tool: e.tool_name, detail: 'Asked a question', question: firstQuestion(e.tool_input), since: now });
      if (e.tool_name === 'TodoWrite' && Array.isArray(e.tool_input?.todos)) {
        const todos = e.tool_input.todos;
        const current = todos.find((t) => t.status === 'in_progress');
        s.todo = { current: clip(current?.activeForm ?? current?.content, 80), done: todos.filter((t) => t.status === 'completed').length, total: todos.length };
      }
      this.#activity(s, describeTool(e.tool_name, e.tool_input), a, now);
    },
    PermissionRequest: (s, e, now) => {
      const a = this.#agent(s, e);
      const candidates = [...a.open].filter(([id, tool]) => tool === e.tool_name && !a.pending.has(id));
      if (e.tool_name === 'AskUserQuestion' && candidates.length === 0) return;
      const id = candidates.at(-1)?.[0] ?? `~perm-${now}`;
      a.pending.set(id, { tool: e.tool_name, detail: `Needs permission: ${describeTool(e.tool_name, e.tool_input)}`, since: now });
    },
    PostToolUse: (s, e, now) => {
      const a = this.#agent(s, e);
      a.open.delete(e.tool_use_id);
      a.pending.delete(e.tool_use_id);
      for (const id of a.pending.keys()) if (id.startsWith('~')) a.pending.delete(id);
      setBase(a, 'working', now);
      s.summaryWanted = true;
    },
    PostToolUseFailure: (s, e, now) => this.#handlers.PostToolUse(s, e, now),
    Notification: (s, e, now) => {
      const main = s.agents.get('main');
      if (e.notification_type === 'permission_prompt') {
        const anyPending = [...s.agents.values()].some((a) => a.pending.size > 0);
        if (!anyPending) main.pending.set(`~notify-${now}`, { tool: null, detail: 'Needs permission', since: now });
      } else if (e.notification_type === 'idle_prompt') {
        clearAll(main);
        setBase(main, 'waiting', now, DONE);
      }
    },
    Stop: (s, e, now) => {
      const main = s.agents.get('main');
      clearAll(main);
      setBase(main, 'waiting', now, DONE);
      s.lastMessage = keepLines(e.last_assistant_message, 1500);
      s.summaryWanted = true;
      s.summaryNow = true;
      this.#syncBackground(s, e.background_tasks, now);
    },
    StopFailure: (s, e, now) => {
      const main = s.agents.get('main');
      clearAll(main);
      setBase(main, 'waiting', now, 'Stopped on an error');
    },
    SubagentStart: (s, e, now) => {
      if (!e.agent_id || s.agents.has(e.agent_id) || this.#agentElsewhere(s.id, e.agent_id)) return;
      const a = newAgent(e.agent_id, e.agent_type || null);
      setBase(a, 'working', now);
      s.agents.set(e.agent_id, a);
    },
    SubagentStop: (s, e) => {
      if (e.agent_id && e.agent_id !== 'main') s.agents.delete(e.agent_id);
    },
    TaskCreated: (s, e) => {
      s.tasks.total++;
      s.tasks.current = clip(e.task_subject ?? e.subject ?? e.title ?? e.description, 80) ?? s.tasks.current;
    },
    TaskCompleted: (s) => {
      s.tasks.done = Math.min(s.tasks.done + 1, s.tasks.total);
    },
    MessageDisplay: (s, e) => {
      if (typeof e.delta === 'string') s.recentText = (s.recentText + e.delta).slice(-1500);
    },
    SessionEnd: (s, e, now) => {
      s.ended = now;
      for (const a of s.agents.values()) clearAll(a);
      setBase(s.agents.get('main'), 'ended', now);
    },
  };

  resolve(sessionId, agentKey, { results = {}, interrupted = false }, now = Date.now()) {
    const a = this.sessions.get(sessionId)?.agents.get(agentKey);
    if (!a) return false;
    let changed = false;
    let denied = false;
    for (const [id, outcome] of Object.entries(results)) {
      if (!a.pending.has(id) && !a.open.has(id)) continue;
      a.pending.delete(id);
      a.open.delete(id);
      changed = true;
      if (outcome === 'denied') denied = true;
    }
    if (denied || interrupted) {
      clearAll(a);
      setBase(a, 'waiting', now, denied ? 'You said no' : 'Interrupted');
      changed = true;
    }
    if (changed) this.seq++;
    return changed;
  }

  nextSummary(now = Date.now()) {
    const due = [...this.sessions.values()]
      .filter((s) => s.visible && !s.ended && s.transcriptPath && s.summaryWanted && (s.summaryNow || now - s.summaryAt >= SUMMARY_EVERY_MS))
      .sort((a, b) => b.summaryNow - a.summaryNow || a.summaryAt - b.summaryAt);
    const s = due[0];
    if (!s) return null;
    s.summaryWanted = s.summaryNow = false;
    s.summaryAt = now;
    return { sessionId: s.id, turn: s.turn, project: s.project, transcriptPath: s.transcriptPath };
  }

  setSummary({ sessionId, turn }, text) {
    const s = this.sessions.get(sessionId);
    if (!s || s.turn !== turn || !text || s.summary === text) return false;
    s.summary = clip(text, 90);
    this.seq++;
    return true;
  }

  watchTargets(now = Date.now()) {
    const targets = [];
    for (const s of this.sessions.values()) {
      if (s.ended || !s.transcriptPath) continue;
      for (const a of s.agents.values()) {
        const quiet = a.base === 'working' && now - s.lastEvent > QUIET_WATCH_MS;
        if (a.pending.size === 0 && !quiet) continue;
        const path = a.key === 'main' ? s.transcriptPath : s.transcriptPath.replace(/\.jsonl$/, '') + `/subagents/agent-${a.key}.jsonl`;
        const pendingSince = Math.min(...[...a.pending.values()].map((p) => p.since));
        targets.push({
          sessionId: s.id,
          agentKey: a.key,
          path,
          toolUseIds: [...a.pending.keys(), ...(quiet ? a.open.keys() : [])].filter(isToolUseId),
          since: (Number.isFinite(pendingSince) ? Math.min(pendingSince, a.since) : a.since) - 2000,
        });
      }
    }
    return targets;
  }

  sweep(now = Date.now()) {
    let changed = false;
    for (const [id, s] of this.sessions) {
      const state = this.#sessionView(s, now).state;
      const expired =
        (s.ended && now - s.ended > ENDED_KEEP_MS) ||
        (!s.visible && now - s.lastEvent > HIDDEN_EXPIRE_MS) ||
        (!s.live && (state === 'waiting' || state === 'stale') && now - s.lastEvent > IDLE_EXPIRE_MS);
      if (expired) {
        this.sessions.delete(id);
        changed = true;
      } else if (s.lastState !== state) {
        s.lastState = state;
        changed = true;
      }
    }
    if (changed) this.seq++;
    return changed;
  }

  syncLive(list, now = Date.now()) {
    if (!list) return false;
    let changed = false;
    const ids = new Set(list.map((l) => l.id));
    for (const s of this.sessions.values()) {
      if (!s.live || ids.has(s.id)) continue;
      s.live = false;
      changed = true;
      if (s.ended) continue;
      s.ended = now;
      for (const a of s.agents.values()) clearAll(a);
      setBase(s.agents.get('main'), 'ended', now);
    }
    for (const l of list) {
      let s = this.sessions.get(l.id);
      if (!s) {
        s = this.#newSession({ session_id: l.id, host: l.host }, now);
        s.started = l.startedAt ?? now;
        s.lastEvent = l.updatedAt ?? now;
        if (l.cwd) {
          s.cwd = l.cwd;
          Object.assign(s, this.locate(l.cwd));
        }
        if (l.status === 'busy') setBase(s.agents.get('main'), 'working', s.lastEvent);
        this.sessions.set(l.id, s);
        changed = true;
      }
      if (s.ended) continue;
      s.live = true;
      if (!s.visible) {
        s.visible = true;
        changed = true;
      }
      const main = s.agents.get('main');
      if (l.status === 'idle' && main.base === 'working' && main.pending.size === 0 && now - s.lastEvent > LIVE_IDLE_AFTER_MS) {
        clearAll(main);
        setBase(main, 'waiting', now, DONE);
        changed = true;
      }
    }
    if (changed) this.seq++;
    return changed;
  }

  dump() {
    const sessions = [...this.sessions.values()].map(({ recentText, ...s }) => ({
      ...s,
      agents: [...s.agents.values()].map((a) => ({ ...a, open: [...a.open], pending: [...a.pending] })),
    }));
    return { version: SAVE_VERSION, seq: this.seq, sessions };
  }

  restore(saved, now = Date.now()) {
    if (saved?.version !== SAVE_VERSION || !Array.isArray(saved.sessions)) return 0;
    for (const s of saved.sessions) {
      const expired =
        now - s.lastEvent > IDLE_EXPIRE_MS ||
        (s.ended && now - s.ended > ENDED_KEEP_MS) ||
        (!s.visible && now - s.lastEvent > HIDDEN_EXPIRE_MS);
      if (expired) continue;
      const agents = new Map(s.agents.map((a) => [a.key, { ...a, open: new Map(a.open), pending: new Map(a.pending) }]));
      this.sessions.set(s.id, { ...s, recentText: '', agents });
    }
    this.seq = Number(saved.seq) || 0;
    return this.sessions.size;
  }

  #sessionView(s, now) {
    if (s.ended) return { state: 'ended', detail: null, question: null, since: s.ended, agent: s.agents.get('main') };
    let top = { ...view(s.agents.get('main')), agent: s.agents.get('main') };
    for (const a of s.agents.values()) {
      if (a.key === 'main') continue;
      const v = view(a);
      const more = URGENCY[v.state] > URGENCY[top.state] || (URGENCY[v.state] === URGENCY[top.state] && NEEDS_YOU.has(v.state) && v.since < top.since);
      if (more) top = { ...v, agent: a };
    }
    if (top.state === 'working' && now - s.lastEvent > STALE_MS) return { ...top, state: 'stale', detail: 'No activity for 30 min' };
    return top;
  }

  snapshot(now = Date.now()) {
    const sessions = [];
    for (const s of this.sessions.values()) {
      if (!s.visible) continue;
      const top = this.#sessionView(s, now);
      const subagents = [...s.agents.values()].filter((a) => a.key !== 'main');
      let detail = top.detail;
      if (detail && top.agent.key !== 'main') detail += ` (${top.agent.type ?? 'subagent'})`;
      const todo = s.todo ?? (s.tasks.total ? { current: s.tasks.current, done: s.tasks.done, total: s.tasks.total } : null);
      sessions.push({
        id: s.id,
        project: this.tabName(s.warpSession) ?? s.project,
        folder: s.project,
        branch: s.branch,
        host: s.host,
        cwd: s.cwd,
        state: top.state,
        detail,
        question: top.question,
        summary: s.summary ?? todo?.current ?? s.lastPrompt ?? clip(plain(s.lastMessage), 160),
        summarySource: s.summary ? 'summary' : todo?.current ? 'todo' : s.lastPrompt ? 'prompt' : s.lastMessage ? 'message' : null,
        lastMessage: s.lastMessage,
        output: top.state === 'working' ? tail(s.recentText, OUTPUT_CHARS) : '',
        todo,
        subagents: subagents.length,
        subagentList: subagents.map((a) => ({ type: a.type, description: a.description, state: view(a).state })),
        since: new Date(top.since || s.lastEvent).toISOString(),
        lastEvent: new Date(s.lastEvent).toISOString(),
        started: new Date(s.started).toISOString(),
        activity: s.activity.slice(0, 10).map((a) => a.text),
        needsYou: NEEDS_YOU.has(top.state),
      });
    }
    sortSessions(sessions);
    return { version: 1, now: new Date(now).toISOString(), seq: this.seq, sessions };
  }
}
