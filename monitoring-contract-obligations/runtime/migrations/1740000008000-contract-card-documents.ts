import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE contract_documents
      ADD COLUMN document_version integer NOT NULL DEFAULT 1,
      ADD COLUMN is_current boolean NOT NULL DEFAULT true,
      ADD COLUMN previous_document_id uuid
        REFERENCES contract_documents(id) ON DELETE SET NULL,
      ADD COLUMN page_count integer,
      ADD CONSTRAINT contract_documents_version_check CHECK (document_version > 0),
      ADD CONSTRAINT contract_documents_page_count_check CHECK (
        page_count IS NULL OR page_count > 0
      );

    CREATE INDEX contract_documents_contract_current_idx
      ON contract_documents(contract_id, is_current);
    CREATE INDEX contract_documents_previous_document_idx
      ON contract_documents(previous_document_id);
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW contract_card AS
    SELECT
      c.id AS contract_id,
      c.contract_number,
      c.title,
      c.contract_type,
      c.counterparty_name,
      c.contract_date,
      c.end_date,
      c.status,
      c.processing_status,
      c.verification_status,
      c.source_system,
      c.source_reference,
      c.origin_contour,
      c.curator_user_id,
      c.created_at,
      c.updated_at,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', d.id,
            'fileName', d.file_name,
            'storageKey', d.storage_key,
            'documentKind', d.document_kind,
            'mimeType', d.mime_type,
            'sha256', d.sha256,
            'processingStatus', d.processing_status,
            'documentVersion', d.document_version,
            'isCurrent', d.is_current,
            'previousDocumentId', d.previous_document_id,
            'pageCount', d.page_count,
            'hasExtractedText', d.extracted_text IS NOT NULL,
            'uploadedAt', d.uploaded_at,
            'processedAt', d.processed_at
          ) ORDER BY d.uploaded_at DESC
        ) FILTER (WHERE d.id IS NOT NULL),
        '[]'::jsonb
      ) AS documents
    FROM contracts AS c
    LEFT JOIN contract_documents AS d ON d.contract_id = c.id
    GROUP BY c.id;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP VIEW IF EXISTS contract_card');

  pgm.sql(`
    DROP INDEX IF EXISTS contract_documents_previous_document_idx;
    DROP INDEX IF EXISTS contract_documents_contract_current_idx;

    ALTER TABLE contract_documents
      DROP CONSTRAINT IF EXISTS contract_documents_page_count_check,
      DROP CONSTRAINT IF EXISTS contract_documents_version_check,
      DROP COLUMN IF EXISTS page_count,
      DROP COLUMN IF EXISTS previous_document_id,
      DROP COLUMN IF EXISTS is_current,
      DROP COLUMN IF EXISTS document_version;
  `);
}
