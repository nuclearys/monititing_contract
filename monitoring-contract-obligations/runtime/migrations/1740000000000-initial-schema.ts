import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  pgm.sql(`
    CREATE TYPE user_role AS ENUM (
      'lawyer',
      'deal_curator',
      'fco',
      'contract_manager',
      'observer',
      'administrator'
    );

    CREATE TYPE contract_status AS ENUM (
      'draft',
      'active',
      'completed',
      'archived'
    );

    CREATE TYPE document_kind AS ENUM (
      'contract',
      'annex',
      'amendment',
      'evidence',
      'other'
    );

    CREATE TYPE document_processing_status AS ENUM (
      'uploaded',
      'queued',
      'processing',
      'ready',
      'failed'
    );

    CREATE TYPE obligation_status AS ENUM (
      'draft',
      'confirmed',
      'rejected'
    );

    CREATE TYPE verification_status AS ENUM (
      'pending',
      'confirmed',
      'corrected',
      'rejected'
    );

    CREATE TYPE execution_status AS ENUM (
      'not_started',
      'in_progress',
      'completed',
      'overdue',
      'not_applicable'
    );
  `);

  pgm.sql(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      external_subject text NOT NULL UNIQUE,
      full_name text NOT NULL,
      email text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_roles (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role user_role NOT NULL,
      PRIMARY KEY (user_id, role)
    );

    CREATE TABLE contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_number text NOT NULL UNIQUE,
      title text NOT NULL,
      counterparty_name text NOT NULL,
      contract_date date,
      end_date date,
      status contract_status NOT NULL DEFAULT 'draft',
      curator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT contracts_dates_check CHECK (
        end_date IS NULL OR contract_date IS NULL OR end_date >= contract_date
      )
    );

    CREATE TABLE contract_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      file_name text NOT NULL,
      storage_key text NOT NULL UNIQUE,
      document_kind document_kind NOT NULL DEFAULT 'other',
      mime_type text NOT NULL,
      sha256 text NOT NULL,
      processing_status document_processing_status NOT NULL DEFAULT 'uploaded',
      extracted_text text,
      uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    );

    CREATE TABLE obligations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      source_document_id uuid REFERENCES contract_documents(id) ON DELETE SET NULL,
      code text NOT NULL,
      title text NOT NULL,
      description text,
      responsible_party text,
      due_date date,
      recurrence text,
      amount numeric(18, 2),
      currency char(3),
      status obligation_status NOT NULL DEFAULT 'draft',
      verification_status verification_status NOT NULL DEFAULT 'pending',
      execution_status execution_status NOT NULL DEFAULT 'not_started',
      confidence numeric(5, 4),
      source_fragment text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (contract_id, code),
      CONSTRAINT obligations_confidence_check CHECK (
        confidence IS NULL OR confidence BETWEEN 0 AND 1
      )
    );

    CREATE TABLE obligation_verification_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      obligation_id uuid NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL CHECK (action IN ('confirmed', 'corrected', 'rejected', 'commented', 'added')),
      previous_value jsonb,
      new_value jsonb,
      comment text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE obligation_execution_updates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      obligation_id uuid NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      status execution_status NOT NULL,
      comment text,
      evidence_document_id uuid REFERENCES contract_documents(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE fco_responses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      obligation_id uuid NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      response_status text NOT NULL CHECK (response_status IN ('accepted', 'rejected', 'needs_clarification')),
      response_text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      entity_type text NOT NULL,
      entity_id uuid NOT NULL,
      action text NOT NULL,
      payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE INDEX contracts_status_idx ON contracts(status);
    CREATE INDEX contracts_curator_user_id_idx ON contracts(curator_user_id);
    CREATE INDEX contract_documents_contract_id_idx ON contract_documents(contract_id);
    CREATE INDEX obligations_contract_id_idx ON obligations(contract_id);
    CREATE INDEX obligations_execution_status_idx ON obligations(execution_status);
    CREATE INDEX obligations_due_date_idx ON obligations(due_date);
    CREATE INDEX obligation_verification_events_obligation_id_idx
      ON obligation_verification_events(obligation_id, created_at DESC);
    CREATE INDEX obligation_execution_updates_obligation_id_idx
      ON obligation_execution_updates(obligation_id, created_at DESC);
    CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS fco_responses;
    DROP TABLE IF EXISTS obligation_execution_updates;
    DROP TABLE IF EXISTS obligation_verification_events;
    DROP TABLE IF EXISTS obligations;
    DROP TABLE IF EXISTS contract_documents;
    DROP TABLE IF EXISTS contracts;
    DROP TABLE IF EXISTS user_roles;
    DROP TABLE IF EXISTS users;
    DROP TYPE IF EXISTS execution_status;
    DROP TYPE IF EXISTS verification_status;
    DROP TYPE IF EXISTS obligation_status;
    DROP TYPE IF EXISTS document_processing_status;
    DROP TYPE IF EXISTS document_kind;
    DROP TYPE IF EXISTS contract_status;
    DROP TYPE IF EXISTS user_role;
  `);
}
