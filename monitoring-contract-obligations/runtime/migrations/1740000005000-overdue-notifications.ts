import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE obligations
      ADD COLUMN overdue_detected_at timestamptz;

    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      obligation_id uuid NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      type text NOT NULL,
      title text NOT NULL,
      message text NOT NULL,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX notifications_recipient_type_obligation_idx
      ON notifications(recipient_user_id, type, obligation_id);
    CREATE INDEX notifications_recipient_unread_idx
      ON notifications(recipient_user_id, read_at, created_at DESC);
    CREATE INDEX obligations_overdue_detected_at_idx
      ON obligations(overdue_detected_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS obligations_overdue_detected_at_idx;
    DROP INDEX IF EXISTS notifications_recipient_unread_idx;
    DROP INDEX IF EXISTS notifications_recipient_type_obligation_idx;
    DROP TABLE IF EXISTS notifications;
    ALTER TABLE obligations DROP COLUMN IF EXISTS overdue_detected_at;
  `);
}
