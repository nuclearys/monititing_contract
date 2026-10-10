import assert from 'node:assert/strict';
import test from 'node:test';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4174';

async function jsonResponse(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

test('health endpoint reports an available database', async () => {
  const { response, body } = await jsonResponse('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: 'ok', database: 'ok' });

  const protectedResponse = await jsonResponse('/api/dashboard');
  assert.equal(protectedResponse.response.status, 401);
});

test('local provider creates a session with a dashboard and paginated registry', async () => {
  const login = `smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetch(`${baseUrl}/auth/provider`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login, password: 'smoke-password', role: 'lawyer' }),
  });

  assert.equal(response.status, 302);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie ?? '', /monitoring_session=/);
  const cookie = setCookie.split(';', 1)[0];
  const headers = { cookie };

  const me = await jsonResponse('/api/me', { headers });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.full_name, login);
  assert.deepEqual(me.body.roles, ['lawyer']);

  const dashboard = await jsonResponse('/api/dashboard', { headers });
  assert.equal(dashboard.response.status, 200);
  assert.ok(Number.isInteger(dashboard.body.contracts));
  assert.ok(Number.isInteger(dashboard.body.totalObligations));
  assert.ok(Number.isInteger(dashboard.body.pendingVerificationContracts));
  assert.ok(Number.isInteger(dashboard.body.noExecutionContracts));
  assert.ok(dashboard.body.contracts >= 1);
  assert.ok(dashboard.body.totalObligations >= 1);

  const taskGroups = await jsonResponse('/api/review-task-groups?status=open', { headers });
  assert.equal(taskGroups.response.status, 200);
  assert.ok(Array.isArray(taskGroups.body));
  assert.ok(taskGroups.body.length >= 1);

  const registry = await jsonResponse('/api/obligations?page=2&page_size=10', { headers });
  assert.equal(registry.response.status, 200);
  assert.equal(registry.body.page, 2);
  assert.equal(registry.body.pageSize, 10);
  assert.ok(Array.isArray(registry.body.items));
  assert.ok(Number.isInteger(registry.body.total));

  const forbiddenAudit = await jsonResponse('/api/audit-events', { headers });
  assert.equal(forbiddenAudit.response.status, 403);

  const adminLogin = `smoke-admin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const adminResponse = await fetch(`${baseUrl}/auth/provider`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login: adminLogin, password: 'smoke-password', role: 'administrator' }),
  });
  assert.equal(adminResponse.status, 302);
  const adminCookie = adminResponse.headers.get('set-cookie').split(';', 1)[0];
  const audit = await jsonResponse('/api/audit-events?page=1&page_size=10', { headers: { cookie: adminCookie } });
  assert.equal(audit.response.status, 200);
  assert.ok(Array.isArray(audit.body.items));
  assert.equal(audit.body.pageSize, 10);
});
