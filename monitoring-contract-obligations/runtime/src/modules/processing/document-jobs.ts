import type { Pool } from 'pg';

export type DocumentJob = Readonly<{ id: string; documentId: string; attempts: number }>;

export async function enqueueDocumentProcessing(pool: Pool, documentId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO document_processing_jobs (document_id, status, available_at)
      VALUES ($1, 'queued', now())
      ON CONFLICT (document_id)
      DO UPDATE SET status = 'queued', available_at = now(), last_error = NULL, updated_at = now()
    `,
    [documentId],
  );
}

export async function claimDocumentJob(pool: Pool, workerId: string): Promise<DocumentJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; document_id: string; attempts: number }>(
      `
        SELECT id, document_id, attempts
        FROM document_processing_jobs
        WHERE status = 'queued' AND available_at <= now()
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (!result.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      `UPDATE document_processing_jobs
       SET status = 'processing', attempts = attempts + 1, locked_by = $2, locked_at = now(), updated_at = now()
       WHERE id = $1`,
      [result.rows[0].id, workerId],
    );
    await client.query('COMMIT');
    return { id: result.rows[0].id, documentId: result.rows[0].document_id, attempts: result.rows[0].attempts + 1 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeDocumentJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE document_processing_jobs SET status = 'completed', updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

export async function failDocumentJob(pool: Pool, jobId: string, message: string, retry: boolean): Promise<void> {
  await pool.query(
    `
      UPDATE document_processing_jobs
      SET status = $2, last_error = $3, available_at = now() + CASE WHEN $2 = 'queued' THEN interval '30 seconds' ELSE interval '0 seconds' END,
          updated_at = now()
      WHERE id = $1
    `,
    [jobId, retry ? 'queued' : 'failed', message.slice(0, 2_000)],
  );
}
