import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE contracts
      ADD COLUMN contract_type text,
      ADD COLUMN origin_contour text;

    ALTER TABLE obligations
      ADD COLUMN source_text text,
      ADD COLUMN source_locator jsonb,
      ADD COLUMN sanction text,
      ADD COLUMN risk_level text,
      ADD COLUMN user_comment text,
      ADD COLUMN verified_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN verified_at timestamptz,
      ADD COLUMN version integer NOT NULL DEFAULT 1,
      ADD COLUMN change_basis text,
      ADD CONSTRAINT obligations_version_check CHECK (version > 0);
  `);

  pgm.sql(`
    CREATE INDEX obligations_risk_level_idx ON obligations(risk_level);
    CREATE INDEX obligations_responsible_party_idx ON obligations(responsible_party);
    CREATE INDEX obligations_verified_by_user_id_idx ON obligations(verified_by_user_id);
    CREATE INDEX obligations_version_idx ON obligations(contract_id, code, version DESC);
    CREATE INDEX contracts_origin_contour_idx ON contracts(origin_contour);
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW obligations_registry AS
    SELECT
      o.id AS obligation_id,
      c.id AS contract_id,
      c.contract_number,
      c.contract_date,
      c.title AS contract_title,
      c.contract_type,
      c.origin_contour,
      c.source_system,
      c.source_reference,
      d.id AS source_document_id,
      d.file_name AS source_document_name,
      o.source_locator,
      o.source_fragment,
      o.source_text,
      o.responsible_party,
      o.title AS obligation_subject,
      o.description AS obligation_description,
      o.due_date,
      o.obligation_type,
      o.sanction,
      o.status AS obligation_status,
      o.verification_status,
      o.execution_status,
      o.risk_level,
      o.confidence,
      o.user_comment,
      o.verified_by_user_id,
      o.verified_at,
      o.version,
      o.change_basis,
      o.actual_execution_date,
      o.overdue_reason,
      o.overdue_comment,
      o.overdue_requires_curator_input,
      o.created_at,
      o.updated_at,
      (
        o.execution_status = 'overdue'
        OR (
          o.due_date < CURRENT_DATE
          AND o.execution_status NOT IN ('completed', 'not_applicable')
        )
      ) AS is_overdue
    FROM obligations AS o
    JOIN contracts AS c ON c.id = o.contract_id
    LEFT JOIN contract_documents AS d ON d.id = o.source_document_id;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP VIEW IF EXISTS obligations_registry');

  pgm.sql(`
    DROP INDEX IF EXISTS contracts_origin_contour_idx;
    DROP INDEX IF EXISTS obligations_version_idx;
    DROP INDEX IF EXISTS obligations_verified_by_user_id_idx;
    DROP INDEX IF EXISTS obligations_responsible_party_idx;
    DROP INDEX IF EXISTS obligations_risk_level_idx;

    ALTER TABLE obligations
      DROP CONSTRAINT IF EXISTS obligations_version_check,
      DROP COLUMN IF EXISTS change_basis,
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS verified_at,
      DROP COLUMN IF EXISTS verified_by_user_id,
      DROP COLUMN IF EXISTS user_comment,
      DROP COLUMN IF EXISTS risk_level,
      DROP COLUMN IF EXISTS sanction,
      DROP COLUMN IF EXISTS source_locator,
      DROP COLUMN IF EXISTS source_text;

    ALTER TABLE contracts
      DROP COLUMN IF EXISTS origin_contour,
      DROP COLUMN IF EXISTS contract_type;
  `);
}
