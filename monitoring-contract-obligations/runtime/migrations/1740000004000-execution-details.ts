import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE obligations
      ADD COLUMN actual_execution_date date,
      ADD COLUMN overdue_reason text,
      ADD COLUMN execution_evidence_document_id uuid
        REFERENCES contract_documents(id) ON DELETE SET NULL;

    ALTER TABLE obligation_execution_updates
      ALTER COLUMN comment SET NOT NULL,
      ADD COLUMN actual_execution_date date,
      ADD COLUMN overdue_reason text;
  `);

  pgm.sql(`
    ALTER TABLE obligations
      ADD CONSTRAINT obligations_completed_execution_check CHECK (
        execution_status <> 'completed'
        OR (
          actual_execution_date IS NOT NULL
          AND execution_evidence_document_id IS NOT NULL
        )
      ),
      ADD CONSTRAINT obligations_overdue_reason_check CHECK (
        execution_status <> 'overdue'
        OR length(trim(coalesce(overdue_reason, ''))) > 0
      );

    ALTER TABLE obligation_execution_updates
      ADD CONSTRAINT execution_updates_completed_check CHECK (
        status <> 'completed'
        OR (
          actual_execution_date IS NOT NULL
          AND evidence_document_id IS NOT NULL
        )
      ),
      ADD CONSTRAINT execution_updates_overdue_reason_check CHECK (
        status <> 'overdue'
        OR length(trim(coalesce(overdue_reason, ''))) > 0
      ),
      ADD CONSTRAINT execution_updates_comment_check CHECK (
        length(trim(comment)) > 0
      );
  `);

  pgm.sql(`
    CREATE INDEX obligations_actual_execution_date_idx
      ON obligations(actual_execution_date);
    CREATE INDEX obligations_execution_evidence_document_id_idx
      ON obligations(execution_evidence_document_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS obligations_execution_evidence_document_id_idx;
    DROP INDEX IF EXISTS obligations_actual_execution_date_idx;

    ALTER TABLE obligation_execution_updates
      DROP CONSTRAINT IF EXISTS execution_updates_comment_check,
      DROP CONSTRAINT IF EXISTS execution_updates_overdue_reason_check,
      DROP CONSTRAINT IF EXISTS execution_updates_completed_check,
      DROP COLUMN IF EXISTS overdue_reason,
      DROP COLUMN IF EXISTS actual_execution_date,
      ALTER COLUMN comment DROP NOT NULL;

    ALTER TABLE obligations
      DROP CONSTRAINT IF EXISTS obligations_overdue_reason_check,
      DROP CONSTRAINT IF EXISTS obligations_completed_execution_check,
      DROP COLUMN IF EXISTS execution_evidence_document_id,
      DROP COLUMN IF EXISTS overdue_reason,
      DROP COLUMN IF EXISTS actual_execution_date;
  `);
}
