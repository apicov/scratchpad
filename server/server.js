// Pico Scratchpad server: plain text notes as files, live updates over Server-Sent Events.
// No dependencies. Env: HOST (default 127.0.0.1), PORT (8787), DATA_DIR (./data), WEB_DIR (../app/www),
// BACKUP_DIR (DATA_DIR/.backups), BACKUP_EVERY_MS (1 h), BACKUP_KEEP_DAYS (30)
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(here, '../app/www'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, '.backups'));
const BACKUP_EVERY_MS = Number(process.env.BACKUP_EVERY_MS ?? 3600e3);
const BACKUP_KEEP_MS = Number(process.env.BACKUP_KEEP_DAYS ?? 30) * 86400e3;
const APP_ORIGIN = 'http://localhost'; // the Capacitor app; the web UI served below is same-origin
const MAX_BYTES = 1024 * 1024;
const NAME_RE = /^[\w\- ][\w.\- ]{0,99}$/; // no slashes, no leading dot
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const clients = new Set(); // open SSE responses
const locks = new Map(); // name -> tail of the queue of writes to that file
const lastBackup = new Map(); // name -> ms of its newest backup

function cors(req, res) {
  if (req.headers.origin !== APP_ORIGIN) return;
  res.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client, If-Match, If-None-Match');
  res.setHeader('Access-Control-Expose-Headers', 'X-Rev');
}

// DNS-rebinding guard: a dotted Host must be an IP or a tailnet name
function hostOk(host = '') {
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return !name.includes('.') || net.isIP(name) !== 0 || name.endsWith('.ts.net');
}

const revOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Run fn after earlier writes to the same file, so check-then-write can't interleave
function locked(name, fn) {
  const run = (locks.get(name) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(name, tail);
  tail.then(() => { if (locks.get(name) === tail) locks.delete(name); });
  return run;
}

async function readOrNull(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, ''); // 2026-11-20_143012 (UTC)

async function newestMtime(dir) {
  let max = 0;
  for (const f of await fs.readdir(dir).catch(() => [])) max = Math.max(max, (await fs.stat(path.join(dir, f))).mtimeMs);
  return max;
}

// Copy text to BACKUP_DIR/<name>/<stamp><ext>; unless forced, at most once per BACKUP_EVERY_MS
async function backup(name, text, force = false) {
  const dir = path.join(BACKUP_DIR, name);
  if (!force) {
    if (!lastBackup.has(name)) lastBackup.set(name, await newestMtime(dir));
    if (Date.now() - lastBackup.get(name) < BACKUP_EVERY_MS) return;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, stamp() + path.extname(name)), text);
  lastBackup.set(name, Date.now());
}

async function pruneBackups() {
  const cutoff = Date.now() - BACKUP_KEEP_MS;
  for (const d of await fs.readdir(BACKUP_DIR).catch(() => [])) {
    const dir = path.join(BACKUP_DIR, d);
    for (const f of await fs.readdir(dir).catch(() => [])) {
      const file = path.join(dir, f);
      if ((await fs.stat(file)).mtimeMs < cutoff) await fs.rm(file);
    }
    await fs.rmdir(dir).catch(() => {}); // only succeeds once empty
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function listFiles() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && NAME_RE.test(e.name) && !e.name.endsWith('.tmp'))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b));
}

async function handleApi(req, res, parts) {
  if (parts[0] === 'events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (parts[0] !== 'files') return send(res, 404, 'not found');
  if (parts.length === 1 && req.method === 'GET') return send(res, 200, JSON.stringify(await listFiles()), 'application/json');

  const name = decodeURIComponent(parts[1] || '');
  if (parts.length !== 2 || !NAME_RE.test(name) || name.endsWith('.tmp')) return send(res, 400, 'bad name');
  const file = path.join(DATA_DIR, name);
  const from = req.headers['x-client'] || '';

  if (req.method === 'GET') {
    const text = await readOrNull(file);
    if (text === null) return send(res, 404, 'no such file');
    res.setHeader('X-Rev', revOf(text));
    return send(res, 200, text);
  }
  if (req.method === 'PUT') {
    // If-Match: <rev> = only overwrite that version (409 + current version otherwise);
    // If-None-Match: * = only create. Without either the write is unconditional.
    const text = await readBody(req);
    const ifMatch = req.headers['if-match'];
    const createOnly = req.headers['if-none-match'] === '*';
    return locked(name, async () => {
      const old = await readOrNull(file);
      if (createOnly && old !== null) return send(res, 412, 'already exists');
      if (ifMatch && old !== text && (old === null || revOf(old) !== ifMatch)) {
        return send(res, 409, JSON.stringify({ rev: old === null ? null : revOf(old), text: old }), 'application/json');
      }
      res.setHeader('X-Rev', revOf(text));
      if (old === text) return send(res, 204, '');
      if (old === null) lastBackup.set(name, Date.now()); // first backup an hour after creation
      else if (old) await backup(name, old);
      await fs.writeFile(file + '.tmp', text);
      await fs.rename(file + '.tmp', file);
      broadcast({ type: 'change', name, text, rev: revOf(text), from });
      if (old === null) broadcast({ type: 'list', files: await listFiles() });
      return send(res, 204, '');
    });
  }
  if (req.method === 'DELETE') {
    return locked(name, async () => {
      const old = await readOrNull(file);
      if (old) await backup(name, old, true);
      await fs.rm(file, { force: true });
      lastBackup.delete(name);
      broadcast({ type: 'delete', name, from });
      broadcast({ type: 'list', files: await listFiles() });
      return send(res, 204, '');
    });
  }
  return send(res, 405, 'method not allowed');
}

async function handleStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep)) return send(res, 404, 'not found');
  try {
    const body = await fs.readFile(file);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch { send(res, 404, 'not found'); }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host)) return send(res, 403, 'bad host');
    cors(req, res);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const urlPath = new URL(req.url, 'http://x').pathname;
    try {
      if (urlPath.startsWith('/api/')) await handleApi(req, res, urlPath.slice(5).split('/').filter(Boolean));
      else if (req.method === 'GET') await handleStatic(req, res, urlPath);
      else send(res, 405, 'method not allowed');
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, e.status ? e.message : 'server error');
      if (!e.status) console.error(e);
    }
  });
}

// Keep SSE connections alive through idle proxies / NAT
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();
setInterval(() => pruneBackups().catch(console.error), 3600e3).unref();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await pruneBackups();
  createServer().listen(PORT, HOST, () => console.log(`scratchpad on http://${HOST}:${PORT}, data in ${DATA_DIR}`));
}
