import type { RegistryRepository } from '../repository-types.js';

export function createDashboardRepository(core: RegistryRepository) {
  return { dashboard: core.dashboard };
}
