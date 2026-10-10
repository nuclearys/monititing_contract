import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TYPE obligation_type AS ENUM (
      'financial',
      'non_financial'
    );
  `);

  pgm.sql(`
    ALTER TABLE obligations
      ADD COLUMN obligation_type obligation_type NOT NULL;

    CREATE INDEX obligations_type_idx ON obligations(obligation_type);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS obligations_type_idx;

    ALTER TABLE obligations
      DROP COLUMN IF EXISTS obligation_type;

    DROP TYPE IF EXISTS obligation_type;
  `);
}
