import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE document_processing_jobs (
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
    CREATE INDEX document_processing_jobs_queue_idx
      ON document_processing_jobs(status, available_at, created_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP INDEX IF EXISTS document_processing_jobs_queue_idx; DROP TABLE IF EXISTS document_processing_jobs;');
}
