import type { RegistryRepository } from '../repository-types.js';

export function createCommentsRepository(core: RegistryRepository) {
  return {
    add: core.addObligationComment,
    list: core.obligationComments,
  };
}
