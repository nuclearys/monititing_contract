import { createDatabasePool } from '../src/infrastructure/database.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('Set DATABASE_URL in runtime/.env. See runtime/.env.example.');
}

const pool = createDatabasePool(databaseUrl);
try {
  const result = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'users',
          'contracts',
          'contract_documents',
          'obligations',
          'obligation_verification_events',
          'obligation_execution_updates',
          'fco_responses',
          'audit_events'
        )
      ORDER BY table_name
    `,
  );

  console.log('Connected to PostgreSQL. Application tables:');
  for (const row of result.rows) console.log(`- ${row.table_name}`);

  const statuses = await pool.query<{
    processing_status: string;
    verification_status: string;
  }>(
    `
      SELECT processing_status, verification_status
      FROM contracts
      LIMIT 1
    `,
  );

  console.log('Contract status columns:');
  console.log('- processing_status');
  console.log('- verification_status');
  if (statuses.rows.length === 0) console.log('(no contracts yet)');

  const sourceColumn = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'contracts'
        AND column_name IN ('source_system', 'source_reference')
      ORDER BY column_name
    `,
  );

  console.log('Contract source columns:');
  for (const row of sourceColumn.rows) console.log(`- ${row.column_name}`);

  const obligationType = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'obligations'
        AND column_name = 'obligation_type'
    `,
  );

  console.log('Obligation type column:');
  for (const row of obligationType.rows) console.log(`- ${row.column_name}`);

  const executionDetails = await pool.query<{ table_name: string; column_name: string }>(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'obligations' AND column_name IN (
            'actual_execution_date',
            'overdue_reason',
            'execution_evidence_document_id'
          ))
          OR
          (table_name = 'obligation_execution_updates' AND column_name IN (
            'actual_execution_date',
            'overdue_reason'
          ))
        )
      ORDER BY table_name, column_name
    `,
  );

  console.log('Execution detail columns:');
  for (const row of executionDetails.rows)
    console.log(`- ${row.table_name}.${row.column_name}`);

  const overdue = await pool.query<{ table_name: string; column_name: string }>(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'obligations' AND column_name = 'overdue_detected_at')
          OR (table_name = 'obligations' AND column_name IN (
            'overdue_comment',
            'overdue_requires_curator_input'
          ))
          OR table_name = 'notifications'
        )
      ORDER BY table_name, column_name
    `,
  );

  console.log('Overdue and notification columns:');
  for (const row of overdue.rows)
    console.log(`- ${row.table_name}.${row.column_name}`);

  const registry = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name = 'obligations_registry'
    `,
  );

  console.log('Registry view:');
  for (const row of registry.rows) console.log(`- ${row.table_name}`);

  const contractCard = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name = 'contract_card'
    `,
  );

  console.log('Contract card view:');
  for (const row of contractCard.rows) console.log(`- ${row.table_name}`);

  const visibility = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('organizational_units', 'user_access_scopes')
      ORDER BY table_name
    `,
  );

  console.log('Visibility tables:');
  for (const row of visibility.rows) console.log(`- ${row.table_name}`);

  const jobs = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'document_processing_jobs'
    `,
  );

  console.log('Document processing queue:');
  for (const row of jobs.rows) console.log(`- ${row.table_name}`);
} finally {
  await pool.end();
}
