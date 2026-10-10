import { randomUUID } from 'node:crypto';
import { createDatabasePool } from '../src/infrastructure/database.js';
import { loadConfig } from '../src/infrastructure/config.js';
import { createRegistryRepository } from '../src/modules/registry/registry.js';
import { createObligationAnalyzer } from '../src/modules/processing/obligation-analyzer.js';
import {
  claimObligationAnalysisJob,
  completeObligationAnalysisJob,
  failObligationAnalysisJob,
} from '../src/modules/processing/document-jobs.js';

const config = loadConfig(process.env, { requireOidc: false });
const pool = createDatabasePool(config.databaseUrl);
const analyzer = createObligationAnalyzer(createRegistryRepository(pool));
const workerId = `obligation-analysis-worker-${randomUUID()}`;
let stopping = false;

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

async function runOnce(): Promise<boolean> {
  const job = await claimObligationAnalysisJob(pool, workerId);
  if (!job) return false;
  try {
    const processed = await analyzer.process(job.documentId);
    if (!processed) throw new Error('Obligation analyzer returned no result.');
    await completeObligationAnalysisJob(pool, job.id, workerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failObligationAnalysisJob(pool, job.id, workerId, message, job.attempts < 3);
  }
  return true;
}

console.log(`Obligation analysis worker ${workerId} started.`);
while (!stopping) {
  if (!(await runOnce())) await new Promise((resolve) => setTimeout(resolve, 1_000));
}
await pool.end();
