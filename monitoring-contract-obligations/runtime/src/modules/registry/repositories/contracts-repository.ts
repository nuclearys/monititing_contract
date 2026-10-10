import type { RegistryRepository } from '../repository-types.js';

export function createContractsRepository(core: RegistryRepository) {
  return {
    uploadManualDocument: core.uploadManualDocument,
    processingDocument: core.processingDocument,
    markDocumentProcessing: core.markDocumentProcessing,
    saveDocumentExtraction: core.saveDocumentExtraction,
    markDocumentProcessingFailed: core.markDocumentProcessingFailed,
    contractCard: core.contractCard,
    documentText: core.documentText,
  };
}
