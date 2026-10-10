import type { Pool } from 'pg';
import { createRegistryRepository } from './registry.js';
import { createCommentsRepository } from './repositories/comments-repository.js';
import { createContractsRepository } from './repositories/contracts-repository.js';
import { createDashboardRepository } from './repositories/dashboard-repository.js';
import { createObligationsRepository } from './repositories/obligations-repository.js';
import { createTasksRepository } from './repositories/tasks-repository.js';

export function createRegistryDomainModules(pool: Pool) {
  const core = createRegistryRepository(pool);
  const dashboard = createDashboardRepository(core);
  const contracts = createContractsRepository(core);
  const obligations = createObligationsRepository(core);
  const comments = createCommentsRepository(core);
  const tasks = createTasksRepository(core);
  return {
    dashboard: dashboard.dashboard,
    verificationHistory: core.verificationHistory,
    contracts,
    obligations,
    comments,
    tasks,
  };
}
