import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../src/infrastructure/database.js';
import { loadConfig } from '../src/infrastructure/config.js';
import { createObjectStorage } from '../src/infrastructure/object-storage.js';
import { createRegistryRepository } from '../src/modules/registry/registry.js';
import { createDocumentProcessor } from '../src/modules/processing/document-processor.js';
import { claimDocumentJob, completeDocumentJob, failDocumentJob } from '../src/modules/processing/document-jobs.js';

const config = loadConfig(process.env, { requireOidc: false });
const pool = createDatabasePool(config.databaseUrl);
const storage = createObjectStorage(config);
const processor = createDocumentProcessor(createRegistryRepository(pool), storage);
const workerId = `document-worker-${randomUUID()}`;
let stopping = false;

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

async function runOnce(): Promise<boolean> {
  const job = await claimDocumentJob(pool, workerId);
  if (!job) return false;
  try {
    const processed = await processor.process(job.documentId);
    if (!processed) throw new Error('Document processor returned no result.');
    await completeDocumentJob(pool, job.id, workerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failDocumentJob(pool, job.id, workerId, message, job.attempts < 3);
  }
  return true;
}

console.log(`Document worker ${workerId} started.`);
while (!stopping) {
  if (!(await runOnce())) await new Promise((resolve) => setTimeout(resolve, 1_000));
}
await pool.end();
