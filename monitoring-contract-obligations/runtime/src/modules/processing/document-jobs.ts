import type { Pool } from 'pg';

export type DocumentJob = Readonly<{ id: string; documentId: string; attempts: number }>;
export type DocumentAnalysisJob = DocumentJob;

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
    await client.query(
      `
        UPDATE document_processing_jobs
        SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = now(),
            last_error = COALESCE(last_error, 'Задача возвращена в очередь после тайм-аута worker-а.')
        WHERE status = 'processing'
          AND locked_at < now() - ($1::int * interval '1 second')
      `,
      [10 * 60],
    );
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

export async function completeDocumentJob(pool: Pool, jobId: string, workerId: string): Promise<void> {
  await pool.query(
    `
      UPDATE document_processing_jobs
      SET status = 'completed', locked_by = NULL, locked_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'processing' AND locked_by = $2
    `,
    [jobId, workerId],
  );
}

export async function failDocumentJob(pool: Pool, jobId: string, workerId: string, message: string, retry: boolean): Promise<void> {
  await pool.query(
    `
      UPDATE document_processing_jobs
      SET status = $3, locked_by = NULL, locked_at = NULL, last_error = $4,
          available_at = now() + CASE WHEN $3 = 'queued' THEN interval '30 seconds' ELSE interval '0 seconds' END,
          updated_at = now()
      WHERE id = $1 AND status = 'processing' AND locked_by = $2
    `,
    [jobId, workerId, retry ? 'queued' : 'failed', message.slice(0, 2_000)],
  );
}

export async function enqueueObligationAnalysis(pool: Pool, documentId: string): Promise<void> {
  await pool.query(
    `
      INSERT INTO document_ai_processing_jobs (document_id, status, available_at)
      VALUES ($1, 'queued', now())
      ON CONFLICT (document_id)
      DO UPDATE SET status = 'queued', available_at = now(), last_error = NULL, updated_at = now()
    `,
    [documentId],
  );
}

export async function claimObligationAnalysisJob(pool: Pool, workerId: string): Promise<DocumentAnalysisJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        UPDATE document_ai_processing_jobs
        SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = now(),
            last_error = COALESCE(last_error, 'Задача возвращена в очередь после тайм-аута AI worker-а.')
        WHERE status = 'processing'
          AND locked_at < now() - ($1::int * interval '1 second')
      `,
      [10 * 60],
    );
    const result = await client.query<{ id: string; document_id: string; attempts: number }>(
      `
        SELECT id, document_id, attempts
        FROM document_ai_processing_jobs
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
      `
        UPDATE document_ai_processing_jobs
        SET status = 'processing', attempts = attempts + 1, locked_by = $2, locked_at = now(), updated_at = now()
        WHERE id = $1
      `,
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

export async function completeObligationAnalysisJob(pool: Pool, jobId: string, workerId: string): Promise<void> {
  await pool.query(
    `
      UPDATE document_ai_processing_jobs
      SET status = 'completed', locked_by = NULL, locked_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'processing' AND locked_by = $2
    `,
    [jobId, workerId],
  );
}

export async function failObligationAnalysisJob(pool: Pool, jobId: string, workerId: string, message: string, retry: boolean): Promise<void> {
  await pool.query(
    `
      UPDATE document_ai_processing_jobs
      SET status = $3, locked_by = NULL, locked_at = NULL, last_error = $4,
          available_at = now() + CASE WHEN $3 = 'queued' THEN interval '30 seconds' ELSE interval '0 seconds' END,
          updated_at = now()
      WHERE id = $1 AND status = 'processing' AND locked_by = $2
    `,
    [jobId, workerId, retry ? 'queued' : 'failed', message.slice(0, 2_000)],
  );
}
