import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TYPE review_task_status AS ENUM (
      'open',
      'in_progress',
      'completed',
      'declined'
    );

    CREATE TABLE review_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      obligation_id uuid REFERENCES obligations(id) ON DELETE CASCADE,
      comment_event_id uuid NOT NULL UNIQUE REFERENCES obligation_verification_events(id) ON DELETE CASCADE,
      created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      title text NOT NULL,
      comment_text text NOT NULL,
      quoted_text text,
      source_locator jsonb,
      status review_task_status NOT NULL DEFAULT 'open',
      response_comment text,
      responded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      responded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX review_tasks_assignee_status_idx
      ON review_tasks(assignee_user_id, status, created_at DESC);
    CREATE INDEX review_tasks_contract_idx
      ON review_tasks(contract_id, created_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS review_tasks_contract_idx;
    DROP INDEX IF EXISTS review_tasks_assignee_status_idx;
    DROP TABLE IF EXISTS review_tasks;
    DROP TYPE IF EXISTS review_task_status;
  `);
}
