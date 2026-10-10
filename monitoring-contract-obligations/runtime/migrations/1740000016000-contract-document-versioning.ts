import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    WITH ranked AS (
      SELECT
        id,
        row_number() OVER (PARTITION BY contract_id ORDER BY uploaded_at, id) AS version_number,
        lag(id) OVER (PARTITION BY contract_id ORDER BY uploaded_at, id) AS previous_id,
        row_number() OVER (PARTITION BY contract_id ORDER BY uploaded_at DESC, id DESC) = 1 AS current_document
      FROM contract_documents
      WHERE document_kind IN ('contract', 'annex', 'amendment')
    )
    UPDATE contract_documents AS document
    SET document_version = ranked.version_number,
        previous_document_id = ranked.previous_id,
        is_current = ranked.current_document
    FROM ranked
    WHERE document.id = ranked.id;

    CREATE UNIQUE INDEX contract_documents_source_version_idx
      ON contract_documents(contract_id, document_version)
      WHERE document_kind IN ('contract', 'annex', 'amendment');

    CREATE UNIQUE INDEX contract_documents_current_source_idx
      ON contract_documents(contract_id)
      WHERE is_current AND document_kind IN ('contract', 'annex', 'amendment');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS contract_documents_current_source_idx;
    DROP INDEX IF EXISTS contract_documents_source_version_idx;
  `);
}
