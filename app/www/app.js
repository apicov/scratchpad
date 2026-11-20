// Scratchpad client: edits are sent ~150 ms after typing stops; other devices' edits arrive over SSE.
// Every save names the server revision it was based on; if the note changed elsewhere in between,
// our text is kept as a "conflict" copy and the server version is loaded.
// Served by the server itself: use that. In the Android app: the address set with ⚙ (asked on first start).
const servedByServer = location.protocol.startsWith('http') && location.hostname !== 'localhost';
let server = servedByServer ? location.origin : localStorage.getItem('server');
const clientId = Math.random().toString(36).slice(2);
const $ = (id) => document.getElementById(id);
const text = $('text'), tabs = $('tabs'), status = $('status');
let current = localStorage.getItem('current') || '';
let files = [];
const revs = {}; // name -> server revision our copy is based on
const saving = {}; // name -> number of saves queued or in flight
const latest = {}; // name -> newest text queued for saving
const epoch = {}; // name -> bumped on a conflict, so saves queued before it are dropped
let queue = Promise.resolve(); // saves run one at a time
let sendTimer = null;
let events = null;

const api = (p, opts = {}) => fetch(`${server}/api/${p}`, { ...opts, headers: { 'X-Client': clientId, ...opts.headers } });
const fileApi = (name, opts) => api(`files/${encodeURIComponent(name)}`, opts);
const busy = (name) => (sendTimer && name === current) || saving[name] > 0; // unsent or unconfirmed local edits
const splitName = (name) => { const [, base, ext = ''] = name.match(/^(.*?)(\.[^.]*)?$/); return [base, ext]; };
function stamp(seconds) {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${seconds ? p(d.getSeconds()) : ''}`;
}

// Render one tab per note; returns true if the current note changed (e.g. it was deleted)
function showFiles(list) {
  const before = current;
  files = list;
  if (current && !files.includes(current)) current = '';
  if (!current && files.length) current = files[0];
  tabs.replaceChildren(...files.map((f) => {
    const b = document.createElement('button');
    b.textContent = f;
    b.className = f === current ? 'tab active' : 'tab';
    b.onclick = () => switchTo(f);
    return b;
  }));
  tabs.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (!current) text.disabled = true;
  return current !== before;
}

function setText(value) {
  if (text.value === value) return;
  const { selectionStart: s, selectionEnd: e } = text;
  text.value = value;
  text.setSelectionRange(Math.min(s, value.length), Math.min(e, value.length));
}

async function loadCurrent() {
  localStorage.setItem('current', current);
  const name = current;
  if (!name) return setText('');
  text.disabled = true; // no typing until we know which revision we're editing
  await queue; // our own pending saves land first
  const res = await fileApi(name);
  if (name !== current) return;
  if (res.ok && !busy(name)) { revs[name] = res.headers.get('X-Rev'); setText(await res.text()); }
  text.disabled = false;
}

async function refresh() {
  showFiles(await (await api('files')).json());
  await loadCurrent();
}

function switchTo(name) {
  if (sendTimer) flush();
  current = name;
  showFiles(files);
  loadCurrent().catch(() => {});
}

function flush() {
  clearTimeout(sendTimer);
  sendTimer = null;
  const name = current, body = text.value;
  if (!name) return;
  const ep = epoch[name] || 0;
  latest[name] = body;
  saving[name] = (saving[name] || 0) + 1;
  queue = queue.then(() => save(name, body, ep)).catch(() => {}).finally(() => { saving[name]--; });
}

async function save(name, body, ep) {
  if ((epoch[name] || 0) !== ep) return; // superseded by a conflict copy
  // Unknown revision: only create, never overwrite blindly
  const headers = revs[name] ? { 'If-Match': revs[name] } : { 'If-None-Match': '*' };
  const res = await fileApi(name, { method: 'PUT', body, headers });
  if (res.ok) revs[name] = res.headers.get('X-Rev');
  else if (res.status === 409 || res.status === 412) await conflict(name);
}

// The note changed elsewhere since we loaded it: keep our text as a new note, show the server version
async function conflict(name) {
  epoch[name] = (epoch[name] || 0) + 1;
  let body = latest[name];
  if (name === current) { clearTimeout(sendTimer); sendTimer = null; body = text.value; text.disabled = true; }
  const [base, ext] = splitName(name);
  const copy = `${base.slice(0, 60)} conflict ${stamp(true).replace('_', ' ')}${ext}`;
  await fileApi(copy, { method: 'PUT', body, headers: { 'If-None-Match': '*' } });
  const res = await fileApi(name);
  if (res.ok) {
    revs[name] = res.headers.get('X-Rev');
    if (name === current) setText(await res.text());
  } else delete revs[name];
  if (name === current) text.disabled = false;
  alert(`"${name}" was changed on another device at the same time.\nYour version was saved as "${copy}".`);
}

function connect() {
  events?.close();
  events = new EventSource(`${server}/api/events`);
  events.onopen = () => { status.className = 'ok'; status.title = server; refresh().catch(() => {}); };
  events.onerror = () => { status.className = ''; status.title = 'offline'; };
  events.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'list' && showFiles(ev.files)) loadCurrent().catch(() => {});
    if (ev.type === 'delete') delete revs[ev.name];
    // Ignore our own echo, and remote edits while we have unsaved typing (the save will report the conflict)
    if (ev.type === 'change' && ev.from !== clientId && !busy(ev.name)) {
      revs[ev.name] = ev.rev;
      if (ev.name === current) setText(ev.text);
    }
  };
}

text.addEventListener('input', () => { clearTimeout(sendTimer); sendTimer = setTimeout(flush, 150); });

$('new').onclick = async () => {
  const name = prompt('File name', 'notes.md')?.trim();
  if (!name) return;
  if (sendTimer) flush();
  const res = await fileApi(name, { method: 'PUT', body: '', headers: { 'If-None-Match': '*' } });
  if (!res.ok && res.status !== 412) return alert(await res.text()); // 412: exists already, just open it
  current = name;
  await refresh();
  text.focus();
};

$('delete').onclick = async () => {
  if (!current || !confirm(`Delete ${current}?\n(The server keeps a backup.)`)) return;
  clearTimeout(sendTimer); sendTimer = null;
  await queue;
  await fileApi(current, { method: 'DELETE' });
  delete revs[current];
  current = '';
  await refresh();
};

// Snapshot: save the current text as an ordinary local file, independent of the server
$('snapshot').onclick = async () => {
  if (!current) return;
  const [base, ext] = splitName(current);
  const file = `${base}-${stamp(false)}${ext}`;
  const fs = window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins.Filesystem;
  try {
    if (fs) {
      await fs.requestPermissions().catch(() => {}); // only asks on Android 10 and older
      await fs.writeFile({ path: `Scratchpad/${file}`, data: text.value, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
      alert(`Saved to Documents/Scratchpad/${file}`);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text.value], { type: 'text/plain;charset=utf-8' }));
      a.download = file;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  } catch (e) { alert(`Snapshot failed: ${e.message || e}`); }
};

$('settings').onclick = () => {
  const url = prompt('Server URL, e.g. http://100.64.0.1:8787', server || 'http://')?.trim().replace(/\/$/, '');
  if (!url) return;
  server = url;
  localStorage.setItem('server', url);
  connect();
};

// Coming back from background (phone): EventSource may have missed events
document.addEventListener('visibilitychange', () => {
  if (!server) return;
  if (document.visibilityState === 'visible') { if (!events || events.readyState === 2) connect(); else refresh().catch(() => {}); }
  else if (sendTimer) flush();
});

if (server) connect(); else $('settings').click();
