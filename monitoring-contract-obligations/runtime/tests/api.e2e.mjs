import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4174';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://monitoring:local-development-only@127.0.0.1:55434/monitoring_obligations';

async function jsonResponse(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function login(login, role) {
  const response = await fetch(`${baseUrl}/auth/provider`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login, password: 'e2e-password', role }),
  });
  assert.equal(response.status, 302);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie ?? '', /monitoring_session=/);
  return { cookie: setCookie.split(';', 1)[0] };
}

test('document upload, lawyer verification and curator response work end to end', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const contractNumber = `E2E-${Date.now()}`;
  let createdContractId = null;
  let createdDocumentId = null;
  let uploadedStorageKey = null;
  let verificationObligationId = null;
  let verificationLawyerId = null;
  let commentTaskId = null;
  let commentEventId = null;

  try {
    const manager = await login(`e2e-manager-${Date.now()}`, 'contract_manager');
    const source = await readFile(new URL('../../test-data/Договор_поставки_без_исполнения_2026.docx', import.meta.url));
    const form = new FormData();
    form.append('contractNumber', contractNumber);
    form.append('title', 'E2E договор без исполнения');
    form.append('counterpartyName', 'E2E контрагент');
    form.append('contractDate', '2026-10-10');
    form.append('documentKind', 'contract');
    form.append('file', new Blob([source]), 'Договор_поставки_без_исполнения_2026.docx');

    const upload = await jsonResponse('/api/documents/upload', {
      method: 'POST',
      headers: { cookie: manager.cookie },
      body: form,
    });
    assert.equal(upload.response.status, 201);
    createdContractId = upload.body.contractId;
    createdDocumentId = upload.body.documentId;
    assert.equal(upload.body.processingStatus, 'queued');

    const job = await pool.query(
      'SELECT status FROM document_processing_jobs WHERE document_id = $1',
      [createdDocumentId],
    );
    assert.equal(job.rows[0]?.status, 'queued');

    const card = await jsonResponse(`/api/contracts/${createdContractId}`, { headers: { cookie: manager.cookie } });
    assert.equal(card.response.status, 200);
    assert.equal(card.body.contract_id, createdContractId);
    assert.ok(Array.isArray(card.body.documents));

    const lawyer = await login(`e2e-lawyer-${Date.now()}`, 'lawyer');
    const me = await jsonResponse('/api/me', { headers: { cookie: lawyer.cookie } });
    verificationLawyerId = me.body.id;
    const groups = await jsonResponse('/api/review-task-groups?status=open', { headers: { cookie: lawyer.cookie } });
    assert.equal(groups.response.status, 200);
    assert.ok(groups.body.length > 0);
    const group = await jsonResponse(`/api/review-task-groups/${groups.body[0].contract_id}`, { headers: { cookie: lawyer.cookie } });
    const pending = group.body.find((item) => item.verification_status === 'pending');
    assert.ok(pending, 'an open verification obligation is required for the e2e scenario');
    verificationObligationId = pending.obligation_id;

    const verified = await jsonResponse(`/api/obligations/${verificationObligationId}/verification`, {
      method: 'PATCH',
      headers: { cookie: lawyer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed', executionNotRequired: false }),
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.status, 'confirmed');

    const comment = `E2E замечание ${Date.now()}`;
    const createdComment = await jsonResponse(`/api/obligations/${verificationObligationId}/comments`, {
      method: 'POST',
      headers: { cookie: lawyer.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ comment, sourceLocator: { selectedText: 'E2E фрагмент' } }),
    });
    assert.equal(createdComment.response.status, 201);
    commentTaskId = createdComment.body.taskId;

    const taskEvent = await pool.query('SELECT comment_event_id FROM review_tasks WHERE id = $1', [commentTaskId]);
    commentEventId = taskEvent.rows[0]?.comment_event_id ?? null;

    const curator = await login('demo.curator', 'deal_curator');
    const tasks = await jsonResponse('/api/review-tasks?status=open&task_type=comment_response', { headers: { cookie: curator.cookie } });
    const task = tasks.body.find((item) => item.id === commentTaskId);
    assert.ok(task, 'the curator should receive the comment response task');
    const completed = await jsonResponse(`/api/review-tasks/${commentTaskId}`, {
      method: 'PATCH',
      headers: { cookie: curator.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', responseComment: 'E2E ответ куратора' }),
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.status, 'completed');
  } finally {
    if (commentTaskId) await pool.query('DELETE FROM review_tasks WHERE id = $1', [commentTaskId]);
    if (commentEventId) await pool.query('DELETE FROM obligation_verification_events WHERE id = $1', [commentEventId]);
    if (verificationObligationId) {
      await pool.query(
        `UPDATE obligations SET verification_status = 'pending', status = 'draft', execution_status = 'not_started', updated_at = now() WHERE id = $1`,
        [verificationObligationId],
      );
      await pool.query(
        `UPDATE review_tasks SET status = 'open', response_comment = NULL, responded_by_user_id = NULL, responded_at = NULL, updated_at = now() WHERE obligation_id = $1 AND task_type = 'verification'`,
        [verificationObligationId],
      );
      if (verificationLawyerId) {
        await pool.query(
          `DELETE FROM obligation_verification_events WHERE obligation_id = $1 AND actor_user_id = $2`,
          [verificationObligationId, verificationLawyerId],
        );
      }
    }
    if (createdContractId) {
      const storage = await pool.query('SELECT storage_key FROM contract_documents WHERE id = $1', [createdDocumentId]);
      uploadedStorageKey = storage.rows[0]?.storage_key ?? null;
      await pool.query('DELETE FROM contracts WHERE id = $1', [createdContractId]);
    }
    if (uploadedStorageKey) await unlink(join(process.cwd(), 'storage', uploadedStorageKey)).catch(() => undefined);
    await pool.end();
  }
});
