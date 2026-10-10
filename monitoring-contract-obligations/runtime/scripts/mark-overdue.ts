import { createDatabasePool } from '../src/infrastructure/database.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL in runtime/.env. See runtime/.env.example.');
}

const pool = createDatabasePool(databaseUrl);
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const overdue = await client.query<{
    id: string;
    contract_id: string;
    code: string;
    title: string;
    curator_user_id: string | null;
  }>(`
    UPDATE obligations AS o
    SET
      execution_status = 'overdue',
      overdue_reason = COALESCE(overdue_reason, 'Автоматически: срок исполнения истёк'),
      overdue_detected_at = COALESCE(overdue_detected_at, now()),
      overdue_requires_curator_input = true,
      updated_at = now()
    FROM contracts AS c
    WHERE o.contract_id = c.id
      AND o.due_date < CURRENT_DATE
      AND o.execution_status IN ('not_started', 'in_progress')
    RETURNING o.id, o.contract_id, o.code, o.title, c.curator_user_id
  `);

  for (const row of overdue.rows) {
    await client.query(
      `
        INSERT INTO obligation_execution_updates (
          obligation_id,
          actor_user_id,
          status,
          comment,
          overdue_reason
        )
        VALUES ($1, NULL, 'overdue', $2, $3)
      `,
      [
        row.id,
        'Система автоматически зафиксировала истечение срока исполнения.',
        'Автоматически: срок исполнения истёк',
      ],
    );

    await client.query(
      `
        INSERT INTO audit_events (
          actor_user_id,
          entity_type,
          entity_id,
          action,
          payload
        )
        VALUES (NULL, 'obligation', $1, 'overdue_detected', $2::jsonb)
      `,
      [
        row.id,
        JSON.stringify({ contractId: row.contract_id, code: row.code }),
      ],
    );

    if (row.curator_user_id) {
      await client.query(
        `
          INSERT INTO notifications (
            recipient_user_id,
            obligation_id,
            type,
            title,
            message
          )
          VALUES ($1, $2, 'obligation_overdue', $3, $4)
          ON CONFLICT (recipient_user_id, type, obligation_id) DO NOTHING
        `,
        [
          row.curator_user_id,
          row.id,
          'Просрочено обязательство',
          `Обязательство ${row.code} «${row.title}» просрочено. Требуется комментарий куратора.`,
        ],
      );
    }
  }

  await client.query('COMMIT');
  console.log(`Marked overdue: ${overdue.rowCount ?? 0}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
