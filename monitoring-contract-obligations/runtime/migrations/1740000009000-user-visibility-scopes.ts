import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TYPE organizational_unit_type AS ENUM (
      'business_unit',
      'legal_service',
      'fco',
      'branch'
    );

    CREATE TABLE organizational_units (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      unit_type organizational_unit_type NOT NULL,
      code text NOT NULL,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (unit_type, code)
    );

    CREATE TYPE access_scope_type AS ENUM (
      'business_unit',
      'legal_service',
      'fco',
      'branch',
      'full_perimeter'
    );

    CREATE TABLE user_access_scopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope_type access_scope_type NOT NULL,
      organizational_unit_id uuid REFERENCES organizational_units(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_access_scopes_target_check CHECK (
        (scope_type = 'full_perimeter' AND organizational_unit_id IS NULL)
        OR
        (scope_type <> 'full_perimeter' AND organizational_unit_id IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX user_access_scopes_unique_target_idx
      ON user_access_scopes(user_id, scope_type, organizational_unit_id);
    CREATE UNIQUE INDEX user_access_scopes_full_perimeter_idx
      ON user_access_scopes(user_id)
      WHERE scope_type = 'full_perimeter';
    CREATE INDEX user_access_scopes_user_idx
      ON user_access_scopes(user_id, scope_type);

    ALTER TABLE contracts
      ADD COLUMN business_unit_id uuid REFERENCES organizational_units(id) ON DELETE SET NULL,
      ADD COLUMN legal_service_id uuid REFERENCES organizational_units(id) ON DELETE SET NULL,
      ADD COLUMN fco_id uuid REFERENCES organizational_units(id) ON DELETE SET NULL,
      ADD COLUMN branch_id uuid REFERENCES organizational_units(id) ON DELETE SET NULL;

    CREATE INDEX contracts_business_unit_id_idx ON contracts(business_unit_id);
    CREATE INDEX contracts_legal_service_id_idx ON contracts(legal_service_id);
    CREATE INDEX contracts_fco_id_idx ON contracts(fco_id);
    CREATE INDEX contracts_branch_id_idx ON contracts(branch_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS contracts_branch_id_idx;
    DROP INDEX IF EXISTS contracts_fco_id_idx;
    DROP INDEX IF EXISTS contracts_legal_service_id_idx;
    DROP INDEX IF EXISTS contracts_business_unit_id_idx;

    ALTER TABLE contracts
      DROP COLUMN IF EXISTS branch_id,
      DROP COLUMN IF EXISTS fco_id,
      DROP COLUMN IF EXISTS legal_service_id,
      DROP COLUMN IF EXISTS business_unit_id;

    DROP INDEX IF EXISTS user_access_scopes_user_idx;
    DROP INDEX IF EXISTS user_access_scopes_full_perimeter_idx;
    DROP INDEX IF EXISTS user_access_scopes_unique_target_idx;
    DROP TABLE IF EXISTS user_access_scopes;
    DROP TYPE IF EXISTS access_scope_type;
    DROP TABLE IF EXISTS organizational_units;
    DROP TYPE IF EXISTS organizational_unit_type;
  `);
}
