import type { RegistryRepository } from '../repository-types.js';

export function createTasksRepository(core: RegistryRepository) {
  return {
    groups: core.reviewTaskGroups,
    group: core.reviewTaskGroup,
    list: core.reviewTasks,
    update: core.updateReviewTask,
  };
}
