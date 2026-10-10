import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE INDEX audit_events_created_at_idx
      ON audit_events(created_at DESC);
    CREATE INDEX audit_events_actor_created_at_idx
      ON audit_events(actor_user_id, created_at DESC);
    CREATE INDEX document_processing_jobs_processing_lock_idx
      ON document_processing_jobs(status, locked_at)
      WHERE status = 'processing';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS document_processing_jobs_processing_lock_idx;
    DROP INDEX IF EXISTS audit_events_actor_created_at_idx;
    DROP INDEX IF EXISTS audit_events_created_at_idx;
  `);
}
