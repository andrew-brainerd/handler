import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const EVENTS = [
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
];

const mode = process.argv[2];
if (mode !== 'install' && mode !== 'uninstall') {
  console.error('usage: node scripts/spike-hooks.mjs install|uninstall');
  process.exit(1);
}

const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookScript = resolve(import.meta.dirname, '..', 'hook', 'log-hook.mjs').replaceAll('\\', '/');
const isOurs = (h) => (h.args ?? []).includes(hookScript);

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
  for (const name of EVENTS) {
    settings.hooks[name] ??= [];
    settings.hooks[name].push({ hooks: [{ type: 'command', command: 'node', args: [hookScript], async: true }] });
  }
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${mode === 'install' ? 'Installed' : 'Removed'} Tally spike hooks (${EVENTS.length} events) in ${settingsPath}`);
