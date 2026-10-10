import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://monitoring:local-development-only@127.0.0.1:55434/monitoring_obligations';

test('document reprocessing keeps the source version and creates a lawyer review task for changed obligations', async () => {
  const { createRegistryRepository } = await import('../src/modules/registry/registry.ts');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let contractId = null;
  let userId = null;
  try {
    const user = await pool.query(
      `INSERT INTO users (external_subject, full_name) VALUES ($1, $2) RETURNING id`,
      [`versioning-test-${Date.now()}`, 'Тест версий договора'],
    );
    userId = user.rows[0].id;
    await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'lawyer')`, [userId]);
    const contract = await pool.query(
      `
        INSERT INTO contracts (
          contract_number, title, counterparty_name, source_system,
          processing_status, verification_status
        )
        VALUES ($1, 'Тест версионирования', 'Тестовый контрагент', 'manual', 'queued', 'not_started')
        RETURNING id
      `,
      [`VERSION-${Date.now()}`],
    );
    contractId = contract.rows[0].id;
    const first = await pool.query(
      `
        INSERT INTO contract_documents (
          contract_id, file_name, storage_key, document_kind, mime_type,
          sha256, processing_status, uploaded_by, document_version, is_current
        )
        VALUES ($1, 'contract-v1.docx', $2, 'contract', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'version-test-v1', 'queued', $3, 1, true)
        RETURNING id
      `,
      [contractId, `version-test-v1-${Date.now()}`, userId],
    );
    const firstDocumentId = first.rows[0].id;
    const repository = createRegistryRepository(pool);
    await repository.saveDocumentExtraction(firstDocumentId, 'Срок до 15 ноября 2026 года.', [{
      title: 'Поставка оборудования',
      description: 'Поставить оборудование до 15 ноября 2026 года.',
      responsibleParty: 'Поставщик',
      dueDate: '2026-11-15',
      obligationType: 'non_financial',
      sourceFragment: 'Поставщик обязан поставить оборудование до 15 ноября 2026 года.',
    }], 'test-model');
    await pool.query(`UPDATE contract_documents SET is_current = false WHERE id = $1`, [firstDocumentId]);

    const second = await pool.query(
      `
        INSERT INTO contract_documents (
          contract_id, file_name, storage_key, document_kind, mime_type,
          sha256, processing_status, uploaded_by, document_version, is_current, previous_document_id
        )
        VALUES ($1, 'contract-v2.docx', $2, 'amendment', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'version-test-v2', 'queued', $3, 2, true, $4)
        RETURNING id
      `,
      [contractId, `version-test-v2-${Date.now()}`, userId, firstDocumentId],
    );
    const secondDocumentId = second.rows[0].id;
    const result = await repository.saveDocumentExtraction(secondDocumentId, 'Срок до 23 ноября 2026 года.', [{
      title: 'Поставка оборудования',
      description: 'Поставить оборудование до 23 ноября 2026 года.',
      responsibleParty: 'Поставщик',
      dueDate: '2026-11-23',
      obligationType: 'non_financial',
      sourceFragment: 'Поставщик обязан поставить оборудование до 23 ноября 2026 года.',
    }], 'test-model');

    assert.equal(result.documentVersion, 2);
    assert.equal(result.changesForReview, 1);
    const obligation = await pool.query(
      `SELECT id, due_date::text AS due_date, version, verification_status, source_document_id FROM obligations WHERE contract_id = $1`,
      [contractId],
    );
    assert.equal(obligation.rows[0].due_date, '2026-11-23');
    assert.equal(obligation.rows[0].version, 2);
    assert.equal(obligation.rows[0].verification_status, 'pending');
    assert.equal(obligation.rows[0].source_document_id, secondDocumentId);
    const task = await pool.query(
      `SELECT status, source_locator FROM review_tasks WHERE contract_id = $1 AND task_type = 'verification'`,
      [contractId],
    );
    assert.equal(task.rows.length, 1);
    assert.equal(task.rows[0].status, 'open');
    assert.equal(task.rows[0].source_locator.documentVersion, 2);
    const history = await pool.query(
      `SELECT previous_value, new_value FROM obligation_verification_events WHERE obligation_id = $1 AND comment LIKE 'Источник обновлён:%'`,
      [obligation.rows[0].id],
    );
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].previous_value.values.dueDate, '2026-11-14T19:00:00.000Z');
    assert.equal(history.rows[0].new_value.changedFields.dueDate, '2026-11-23');
  } finally {
    if (contractId) await pool.query('DELETE FROM contracts WHERE id = $1', [contractId]);
    if (userId) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  }
});
