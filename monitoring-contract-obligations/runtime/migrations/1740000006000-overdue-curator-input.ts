import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE obligations
      ADD COLUMN overdue_comment text,
      ADD COLUMN overdue_requires_curator_input boolean NOT NULL DEFAULT false;

    ALTER TABLE obligations
      DROP CONSTRAINT IF EXISTS obligations_overdue_reason_check,
      ADD CONSTRAINT obligations_overdue_input_check CHECK (
        execution_status <> 'overdue'
        OR overdue_requires_curator_input
        OR (
          length(trim(coalesce(overdue_comment, ''))) > 0
          AND length(trim(coalesce(overdue_reason, ''))) > 0
        )
      );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE obligations
      DROP CONSTRAINT IF EXISTS obligations_overdue_input_check,
      DROP COLUMN IF EXISTS overdue_requires_curator_input,
      DROP COLUMN IF EXISTS overdue_comment,
      ADD CONSTRAINT obligations_overdue_reason_check CHECK (
        execution_status <> 'overdue'
        OR length(trim(coalesce(overdue_reason, ''))) > 0
      );
  `);
}
