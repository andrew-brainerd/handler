const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const form = $('form');

let view = null;
let page = 'board';
let up = null;

function show(name) {
  page = name;
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('on', el.dataset.page === name);
  for (const el of document.querySelectorAll('.page')) el.classList.toggle('on', el.id === name);
  if (name === 'settings') refresh();
}

function fill(settings) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'radio') el.checked = settings[el.name] === el.value;
    else if (el.type === 'checkbox') el.checked = settings[el.name];
    else el.value = settings[el.name];
  }
  roleChanged();
}

function read() {
  const data = new FormData(form);
  return {
    role: data.get('role') ?? 'main',
    forwardUrl: data.get('forwardUrl').trim(),
    port: Number(data.get('port')),
    summaries: form.elements.summaries.checked,
    rokuIps: data.get('rokuIps').trim(),
    notifications: form.elements.notifications.checked,
    startOnLogin: form.elements.startOnLogin.checked,
    nodePath: data.get('nodePath').trim(),
  };
}

function roleChanged() {
  const forward = form.elements.role.value === 'forward';
  $('forward-field').hidden = !forward;
  $('roku-field').hidden = forward;
}

function render(next) {
  const urlChanged = view?.relayUrl !== next.relayUrl;
  view = next;
  if (urlChanged) {
    up = null;
    $('frame').src = `${view.relayUrl}/`;
  }
  const r = view.relay;
  $('relay-detail').textContent = r.running
    ? `Running (pid ${r.pid}) at ${view.relayUrl}${r.error ? `. Last problem: ${r.error}` : ''}`
    : `Not running. ${r.error ?? ''}`;
  $('node-found').textContent = r.node ? `Using ${r.node}` : 'Node.js not found yet.';
  $('log').textContent = r.logTail.join('\n') || '(no output yet)';
  $('log').scrollTop = $('log').scrollHeight;
}

async function refresh() {
  render(await invoke('state'));
}

async function poll() {
  if (!view) return;
  let status = null;
  try {
    const res = await fetch(`${view.relayUrl}/status`, { cache: 'no-store' });
    if (res.ok) status = await res.json();
  } catch {}
  const nowUp = !!status;
  if (nowUp && up === false) $('frame').src = `${view.relayUrl}/`;
  up = nowUp;
  $('down').hidden = nowUp;
  $('down-detail').textContent = view.relay.error ?? `Waiting for ${view.relayUrl}`;
  const sessions = status?.sessions ?? [];
  const needs = sessions.filter((s) => s.needsYou).length;
  const working = sessions.filter((s) => s.state === 'working').length;
  $('lamp').className = `lamp ${needs ? 'needs' : working ? 'working' : ''}`;
  const state = $('relay-state');
  state.className = `relay-state ${nowUp ? '' : 'bad'}`;
  state.textContent = !nowUp
    ? 'Relay not answering'
    : `${view.settings.role === 'forward' ? `Forwarding to ${view.settings.forwardUrl} · ` : ''}${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  if (!nowUp || page === 'settings') refresh();
}

for (const el of document.querySelectorAll('.tab')) el.addEventListener('click', () => show(el.dataset.page));
for (const el of form.elements.role) el.addEventListener('change', roleChanged);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('saved').textContent = '';
  try {
    render(await invoke('save_settings', { settings: read() }));
    $('saved').textContent = 'Saved';
    setTimeout(() => ($('saved').textContent = ''), 2500);
  } catch (err) {
    $('saved').textContent = String(err);
  }
});

async function hooks(install) {
  const out = $('hooks-out');
  out.hidden = false;
  out.textContent = install ? 'Installing…' : 'Removing…';
  try {
    out.textContent = await invoke('hooks', { install });
  } catch (err) {
    out.textContent = `Failed: ${err}`;
  }
}

$('install').addEventListener('click', () => hooks(true));
$('uninstall').addEventListener('click', () => hooks(false));
$('restart').addEventListener('click', async () => {
  await invoke('restart_relay');
  setTimeout(refresh, 800);
});

listen('show-page', (e) => show(e.payload));
listen('changed', (e) => {
  render(e.payload);
  fill(e.payload.settings);
});

(async () => {
  const first = await invoke('state');
  render(first);
  fill(first.settings);
  if (location.hash === '#settings') show('settings');
  poll();
  setInterval(poll, 2000);
})();
