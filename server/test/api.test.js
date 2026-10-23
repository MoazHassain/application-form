import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

async function boot() {
  const app = createApp({
    uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'up-')),
    dbPath: ':memory:',
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sam.demo' }) });
  return { app, server, base, cookie: r.headers.get('set-cookie').split(';')[0] };
}
const pdf = () => new Blob(['%PDF-1.4\n%demo\n'], { type: 'application/pdf' });
const form = (file = pdf(), name = 'Sam Demo') => {
  const fd = new FormData();
  fd.set('roleId', 'role-12'); fd.set('name', name); fd.set('email', 'sam@example.com'); fd.set('note', 'hi');
  fd.set('cv', file, 'cv.pdf');
  return fd;
};
const send = (c, key, fd = form(), cookie = c.cookie) =>
  fetch(`${c.base}/api/applications`, { method: 'POST', body: fd, headers: { cookie, 'Idempotency-Key': key } });

test('1. failed upload: 500, nothing saved, retry with same key succeeds', async () => {
  const c = await boot();
  const good = c.app.locals.uploadDir;
  c.app.locals.uploadDir = path.join(import.meta.filename, 'cannot-mkdir-here'); // a path under a file
  assert.equal((await send(c, 'k1')).status, 500);
  c.app.locals.uploadDir = good;
  assert.equal((await send(c, 'k1')).status, 201);
  c.server.close();
});

test('2. retry after timeout: same key replays the original result, no duplicate', async () => {
  const c = await boot();
  const a = await send(c, 'k2');
  const b = await send(c, 'k2');
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal((await b.json()).id, (await a.json()).id);
  assert.equal((await send(c, 'k2-new')).status, 409); // a different request is blocked by the one-per-role rule
  c.server.close();
});

test('3. expired or missing session returns 401', async () => {
  const c = await boot();
  assert.equal((await send(c, 'k3', form(), '')).status, 401);
  c.server.close();
});

test('4. a text file renamed .pdf is rejected on magic bytes', async () => {
  const c = await boot();
  const res = await send(c, 'k4', form(new Blob(['hello'], { type: 'application/pdf' })));
  assert.equal(res.status, 422);
  assert.match((await res.json()).errors.cv, /not a valid PDF/);
  c.server.close();
});

test('5. oversize file is rejected', async () => {
  const c = await boot();
  const big = new Blob(['%PDF-', new Uint8Array(3 * 1024 * 1024)], { type: 'application/pdf' });
  assert.equal((await send(c, 'k5', form(big))).status, 422);
  c.server.close();
});

test('6. a duplicate application with a new key returns 409', async () => {
  const c = await boot();
  assert.equal((await send(c, 'first')).status, 201);
  assert.equal((await send(c, 'second')).status, 409);
  c.server.close();
});

test('7. the database itself enforces UNIQUE(user_id, role_id)', async () => {
  const c = await boot();
  assert.equal((await send(c, 'a')).status, 201);
  const dup = c.app.locals.db.prepare(
    `INSERT INTO applications (id, user_id, role_id, name, email, file_id, file_name)
     VALUES ('x', 'sam.demo', 'role-12', 'n', 'e', 'f', 'f')`
  );
  assert.throws(() => dup.run(), /UNIQUE constraint failed/);
  c.server.close();
});