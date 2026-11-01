import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SETS = {
  tally: {
    script: 'tally-hook.mjs',
    events: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification',
      'MessageDisplay',
      'SubagentStart',
      'SubagentStop',
      'TaskCreated',
      'TaskCompleted',
      'Stop',
      'StopFailure',
      'SessionEnd',
    ],
  },
  spike: {
    script: 'log-hook.mjs',
    events: [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PermissionDenied',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification',
      'MessageDisplay',
      'SubagentStart',
      'SubagentStop',
      'TaskCreated',
      'TaskCompleted',
      'Stop',
      'StopFailure',
      'PreCompact',
      'PostCompact',
      'CwdChanged',
      'SessionEnd',
    ],
  },
};

const mode = process.argv[2];
const set = process.argv.includes('--spike') ? 'spike' : 'tally';
if (mode !== 'install' && mode !== 'uninstall') {
  console.error('usage: node scripts/hooks.mjs install|uninstall [--spike]');
  process.exit(1);
}

const { script, events } = SETS[set];
const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookScript = resolve(import.meta.dirname, '..', 'hook', script).replaceAll('\\', '/');
const isOurs = (h) => (h.args ?? []).some((a) => a.replaceAll('\\', '/').endsWith(`/hook/${script}`));

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const backup = settingsPath + '.tally-bak';
if (!existsSync(backup)) copyFileSync(settingsPath, backup);

settings.hooks ??= {};
for (const name of Object.keys(settings.hooks)) {
  settings.hooks[name] = settings.hooks[name]
    .map((group) => ({ ...group, hooks: group.hooks.filter((h) => !isOurs(h)) }))
    .filter((group) => group.hooks.length > 0);
  if (settings.hooks[name].length === 0) delete settings.hooks[name];
}

if (mode === 'install') {
  for (const name of events) {
    settings.hooks[name] ??= [];
    settings.hooks[name].push({ hooks: [{ type: 'command', command: 'node', args: [hookScript], async: true }] });
  }
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${mode === 'install' ? 'Installed' : 'Removed'} ${set} hooks (${events.length} events) in ${settingsPath}`);
