import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE review_tasks
      ADD COLUMN parent_task_id uuid REFERENCES review_tasks(id) ON DELETE SET NULL;

    DROP INDEX IF EXISTS review_tasks_verification_obligation_idx;
    CREATE UNIQUE INDEX review_tasks_active_verification_obligation_idx
      ON review_tasks(obligation_id)
      WHERE task_type = 'verification' AND status IN ('open', 'in_progress');
    CREATE INDEX review_tasks_parent_task_idx
      ON review_tasks(parent_task_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS review_tasks_parent_task_idx;
    DROP INDEX IF EXISTS review_tasks_active_verification_obligation_idx;
    CREATE UNIQUE INDEX review_tasks_verification_obligation_idx
      ON review_tasks(obligation_id)
      WHERE task_type = 'verification';
    ALTER TABLE review_tasks DROP COLUMN IF EXISTS parent_task_id;
  `);
}
