// Run: node --test server/server.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scratch-'));
process.env.DATA_DIR = dir;
process.env.BACKUP_EVERY_MS = '0'; // back up on every overwrite
const { createServer } = await import('./server.js');

let server, base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); server.close(); await fs.rm(dir, { recursive: true }); });

test('put, get, list, delete', async () => {
  assert.equal((await fetch(`${base}/api/files/notes.txt`, { method: 'PUT', body: 'hi\nthere' })).status, 204);
  assert.equal(await (await fetch(`${base}/api/files/notes.txt`)).text(), 'hi\nthere');
  assert.deepEqual(await (await fetch(`${base}/api/files`)).json(), ['notes.txt']);
  assert.equal((await fetch(`${base}/api/files/notes.txt`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/files/notes.txt`)).status, 404);
});

test('rejects path tricks', async () => {
  for (const bad of ['..%2Fx', '.hidden', 'a%2Fb', 'x.tmp']) {
    assert.equal((await fetch(`${base}/api/files/${bad}`, { method: 'PUT', body: 'x' })).status, 400, bad);
  }
});

test('change is pushed to event stream with sender id', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // ": hello"
  await fetch(`${base}/api/files/live.txt`, { method: 'PUT', body: 'ä 1', headers: { 'X-Client': 'abc' } });
  let buf = '';
  while (!buf.includes('"change"')) buf += new TextDecoder().decode((await reader.read()).value);
  const event = JSON.parse(buf.split('\n').find((l) => l.includes('"change"')).slice(6));
  assert.deepEqual(event, { type: 'change', name: 'live.txt', text: 'ä 1', rev: event.rev, from: 'abc' });
  assert.match(event.rev, /^[0-9a-f]{16}$/);
  ctrl.abort();
});

const put = (name, body, headers = {}) => fetch(`${base}/api/files/${name}`, { method: 'PUT', body, headers });
const backups = (name) => fs.readdir(path.join(dir, '.backups', name)).catch(() => []);

test('If-Match: stale rev gets 409 with the current version, fresh rev wins', async () => {
  await put('rev.txt', 'one');
  const rev1 = (await fetch(`${base}/api/files/rev.txt`)).headers.get('x-rev');
  const ok = await put('rev.txt', 'two', { 'If-Match': rev1 });
  assert.equal(ok.status, 204);
  const rev2 = ok.headers.get('x-rev');
  assert.notEqual(rev2, rev1);
  const stale = await put('rev.txt', 'three', { 'If-Match': rev1 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { rev: rev2, text: 'two' });
  assert.equal((await put('rev.txt', 'two', { 'If-Match': rev1 })).status, 204, 'same text is no conflict');
  assert.equal((await put('rev.txt', 'four')).status, 204, 'unconditional PUT still works');
  assert.equal(await (await fetch(`${base}/api/files/rev.txt`)).text(), 'four');
});

test('If-Match on a deleted file is a conflict', async () => {
  const res = await put('gone.txt', 'x', { 'If-Match': 'abc' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { rev: null, text: null });
});

test('If-None-Match: * only creates', async () => {
  assert.equal((await put('new.txt', 'a', { 'If-None-Match': '*' })).status, 204);
  assert.equal((await put('new.txt', 'b', { 'If-None-Match': '*' })).status, 412);
  assert.equal(await (await fetch(`${base}/api/files/new.txt`)).text(), 'a');
});

test('overwrite and delete leave backups', async () => {
  await put('bak.md', 'first');
  assert.deepEqual(await backups('bak.md'), [], 'creating is not backed up');
  await put('bak.md', 'second');
  const [one] = await backups('bak.md');
  assert.match(one, /^\d{4}-\d\d-\d\d_\d{6}\.md$/);
  assert.equal(await fs.readFile(path.join(dir, '.backups', 'bak.md', one), 'utf8'), 'first');
  await new Promise((r) => setTimeout(r, 1100)); // next second = new backup file name
  await fetch(`${base}/api/files/bak.md`, { method: 'DELETE' });
  const files = (await backups('bak.md')).sort();
  assert.equal(files.length, 2);
  assert.equal(await fs.readFile(path.join(dir, '.backups', 'bak.md', files[1]), 'utf8'), 'second');
  assert.ok(!(await (await fetch(`${base}/api/files`)).json()).includes('.backups'));
});

test('CORS only for the app origin', async () => {
  const app = await fetch(`${base}/api/files`, { headers: { Origin: 'http://localhost' } });
  assert.equal(app.headers.get('access-control-allow-origin'), 'http://localhost');
  const other = await fetch(`${base}/api/files`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('rejects foreign Host names (DNS rebinding)', async () => {
  const status = (host) => new Promise((resolve, reject) => {
    http.get(`${base}/api/files`, { headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await status('evil.example:8787'), 403);
  for (const ok of ['100.64.0.1:8787', 'myserver:8787', 'myserver.tail1234.ts.net:8787', 'localhost:8787', '[::1]:8787']) {
    assert.equal(await status(ok), 200, ok);
  }
});
