import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL');
if (!decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).pathname).endsWith('_test')) throw new Error('Test database name must end in _test');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = 'test-secret';
process.env.RATE_LIMIT_LOGIN = '2'; // tiny limit to verify the 5/min login throttle behavior
process.env.RATE_LIMIT_GLOBAL = '100000';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');

let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test('login throttles after the configured limit', async () => {
  const attempt = () =>
    fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'no-such-user@example.invalid', password: 'incorrect-password' }),
    });
  assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 401);
  const third = await attempt();
  assert.equal(third.status, 429);
  const body = await third.json();
  assert.equal(body.message, 'ThrottlerException: Too Many Requests');
});
