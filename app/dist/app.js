const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
const form = $('form');

let view = null;
let page = 'board';
let up = null;
let mains = { mains: [], forwarding: null };
let picked = '';

const ADDRESS = '__address__';

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
  picked = settings.forwardUrl ? ADDRESS : settings.forwardHost;
  renderMains();
  roleChanged();
}

function read() {
  const data = new FormData(form);
  return {
    role: data.get('role') ?? 'main',
    forwardUrl: picked === ADDRESS ? data.get('forwardUrl').trim() : '',
    forwardHost: picked === ADDRESS ? '' : picked,
    port: view.settings.port,
    summaries: form.elements.summaries.checked,
    rokuIps: data.get('rokuIps').trim(),
    quietHours: data.get('quietHours').trim(),
    notifications: form.elements.notifications.checked,
    askTv: form.elements.askTv.checked,
    startOnLogin: form.elements.startOnLogin.checked,
    nodePath: data.get('nodePath').trim(),
  };
}

function roleChanged() {
  const forward = form.elements.role.value === 'forward';
  $('forward-field').hidden = !forward;
  $('address-field').hidden = !forward || picked !== ADDRESS;
  $('roku-field').hidden = forward;
}

function renderMains() {
  if (!picked && mains.mains.length === 1) picked = mains.mains[0].host;
  const found = mains.mains.map((m) => [m.host, `${m.host} (${m.address})`]);
  const missing = picked && picked !== ADDRESS && !mains.mains.some((m) => m.host === picked);
  const options = [
    ...(picked ? [] : [['', 'Looking for main relays…']]),
    ...found,
    ...(missing ? [[picked, `${picked} (not found right now)`]] : []),
    [ADDRESS, 'Enter an address…'],
  ];
  const select = $('main-select');
  const signature = JSON.stringify(options);
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  }
  select.value = picked;
  $('main-hint').textContent =
    picked === ADDRESS
      ? ''
      : found.length
        ? 'Found on this network. Sessions here are sent to the relay you pick, so save only if you recognise it.'
        : "Handler needs to be running on the other computer, set to Main, with this version or newer.";
}

async function pollMains() {
  try {
    const res = await fetch(`${view.relayUrl}/mains`, { cache: 'no-store' });
    if (res.ok) mains = await res.json();
  } catch {}
  renderMains();
}

function forwardingLabel() {
  const { forwardHost, forwardUrl } = view.settings;
  const target = forwardUrl || forwardHost;
  return mains.forwarding?.ok === false || (forwardHost && !forwardUrl && !mains.forwarding?.url) ? `Can't reach ${target}` : `Forwarding to ${target}`;
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
  await pollMains();
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
    : `${view.settings.role === 'forward' ? `${forwardingLabel()} · ` : ''}${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  if (!nowUp || page === 'settings') refresh();
}

for (const el of document.querySelectorAll('.tab')) el.addEventListener('click', () => show(el.dataset.page));
for (const el of form.elements.role) el.addEventListener('change', roleChanged);
$('main-select').addEventListener('change', (e) => {
  picked = e.target.value;
  roleChanged();
});

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
