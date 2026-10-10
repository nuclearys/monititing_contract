import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TYPE contract_source_system AS ENUM (
      'manual',
      'kasud',
      'sod'
    );
  `);

  pgm.sql(`
    ALTER TABLE contracts
      ADD COLUMN source_system contract_source_system NOT NULL DEFAULT 'manual',
      ADD COLUMN source_reference text;

    CREATE INDEX contracts_source_system_idx ON contracts(source_system);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS contracts_source_system_idx;

    ALTER TABLE contracts
      DROP COLUMN IF EXISTS source_reference,
      DROP COLUMN IF EXISTS source_system;

    DROP TYPE IF EXISTS contract_source_system;
  `);
}
