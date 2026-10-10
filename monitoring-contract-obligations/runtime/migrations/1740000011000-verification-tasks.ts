import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE review_tasks
      ALTER COLUMN comment_event_id DROP NOT NULL,
      ADD COLUMN task_type text NOT NULL DEFAULT 'comment_response',
      ADD CONSTRAINT review_tasks_task_type_check
        CHECK (task_type IN ('comment_response', 'verification'));

    CREATE UNIQUE INDEX review_tasks_verification_obligation_idx
      ON review_tasks(obligation_id)
      WHERE task_type = 'verification';
    CREATE INDEX review_tasks_type_status_idx
      ON review_tasks(task_type, status, created_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS review_tasks_type_status_idx;
    DROP INDEX IF EXISTS review_tasks_verification_obligation_idx;
    ALTER TABLE review_tasks
      DROP CONSTRAINT IF EXISTS review_tasks_task_type_check,
      DROP COLUMN IF EXISTS task_type,
      ALTER COLUMN comment_event_id SET NOT NULL;
  `);
}
