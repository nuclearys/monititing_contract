import type { RegistryRepository } from '../repository-types.js';

export function createObligationsRepository(core: RegistryRepository) {
  return {
    list: core.list,
    updateExecution: core.updateExecution,
    updateVerification: core.updateObligationVerification,
  };
}
