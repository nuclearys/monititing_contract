import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO review_tasks (
      contract_id, obligation_id, created_by_user_id, assignee_user_id,
      task_type, title, comment_text, quoted_text, source_locator
    )
    SELECT
      obligation.contract_id,
      obligation.id,
      contract.created_by,
      lawyer.id,
      'verification',
      'Проверить извлечённое обязательство «' || obligation.title || '»',
      'Автоматическая задача: проверить обязательство, извлечённое из текста договора.',
      obligation.source_fragment,
      obligation.source_locator
    FROM obligations AS obligation
    JOIN contracts AS contract ON contract.id = obligation.contract_id
    LEFT JOIN LATERAL (
      SELECT u.id
      FROM users AS u
      JOIN user_roles AS role ON role.user_id = u.id AND role.role = 'lawyer'
      WHERE u.is_active = true
      ORDER BY u.created_at
      LIMIT 1
    ) AS lawyer ON true
    WHERE obligation.verification_status = 'pending'
    ON CONFLICT DO NOTHING;
  `);
}

export async function down(): Promise<void> {
  // Backfill is intentionally not rolled back: task history may already contain responses.
}
