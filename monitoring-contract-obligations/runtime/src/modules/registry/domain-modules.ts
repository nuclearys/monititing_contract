import type { Pool } from 'pg';
import { createRegistryRepository } from './registry.js';

export function createRegistryDomainModules(pool: Pool) {
  const core = createRegistryRepository(pool);
  return {
    dashboard: core.dashboard,
    contracts: {
      uploadManualDocument: core.uploadManualDocument,
      processingDocument: core.processingDocument,
      markDocumentProcessing: core.markDocumentProcessing,
      saveDocumentExtraction: core.saveDocumentExtraction,
      markDocumentProcessingFailed: core.markDocumentProcessingFailed,
      contractCard: core.contractCard,
      documentText: core.documentText,
    },
    obligations: {
      list: core.list,
      updateExecution: core.updateExecution,
      updateVerification: core.updateObligationVerification,
    },
    comments: {
      add: core.addObligationComment,
      list: core.obligationComments,
    },
    tasks: {
      groups: core.reviewTaskGroups,
      group: core.reviewTaskGroup,
      list: core.reviewTasks,
      update: core.updateReviewTask,
    },
  };
}
