import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TYPE contract_processing_status AS ENUM (
      'received',
      'queued',
      'processing',
      'ready_for_review',
      'failed',
      'excluded'
    );

    CREATE TYPE contract_verification_status AS ENUM (
      'not_started',
      'in_progress',
      'verified',
      'needs_revision'
    );
  `);

  pgm.sql(`
    ALTER TABLE contracts
      ADD COLUMN processing_status contract_processing_status NOT NULL DEFAULT 'received',
      ADD COLUMN verification_status contract_verification_status NOT NULL DEFAULT 'not_started';

    CREATE INDEX contracts_processing_status_idx ON contracts(processing_status);
    CREATE INDEX contracts_verification_status_idx ON contracts(verification_status);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS contracts_verification_status_idx;
    DROP INDEX IF EXISTS contracts_processing_status_idx;

    ALTER TABLE contracts
      DROP COLUMN IF EXISTS verification_status,
      DROP COLUMN IF EXISTS processing_status;

    DROP TYPE IF EXISTS contract_verification_status;
    DROP TYPE IF EXISTS contract_processing_status;
  `);
}
