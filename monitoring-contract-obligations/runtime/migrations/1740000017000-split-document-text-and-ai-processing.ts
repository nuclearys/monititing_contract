import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TYPE document_ai_processing_status AS ENUM (
      'not_queued',
      'queued',
      'processing',
      'ready',
      'failed'
    );

    ALTER TABLE contract_documents
      ADD COLUMN ai_processing_status document_ai_processing_status NOT NULL DEFAULT 'not_queued',
      ADD COLUMN ai_processed_at timestamptz,
      ADD COLUMN ai_processing_error text;

    CREATE TABLE document_ai_processing_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid NOT NULL UNIQUE REFERENCES contract_documents(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_by text,
      locked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX document_ai_processing_jobs_queue_idx
      ON document_ai_processing_jobs(status, available_at, created_at);
    CREATE INDEX document_ai_processing_jobs_processing_lock_idx
      ON document_ai_processing_jobs(status, locked_at)
      WHERE status = 'processing';

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
            'aiProcessingStatus', d.ai_processing_status,
            'aiProcessedAt', d.ai_processed_at,
            'aiProcessingError', d.ai_processing_error,
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
  pgm.sql(`
    DROP VIEW IF EXISTS contract_card;
    DROP INDEX IF EXISTS document_ai_processing_jobs_processing_lock_idx;
    DROP INDEX IF EXISTS document_ai_processing_jobs_queue_idx;
    DROP TABLE IF EXISTS document_ai_processing_jobs;
    ALTER TABLE contract_documents
      DROP COLUMN IF EXISTS ai_processing_error,
      DROP COLUMN IF EXISTS ai_processed_at,
      DROP COLUMN IF EXISTS ai_processing_status;
    DROP TYPE IF EXISTS document_ai_processing_status;
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
