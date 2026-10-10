import type { RegistryRepository } from '../repository-types.js';

export function createContractsRepository(core: RegistryRepository) {
  return {
    uploadManualDocument: core.uploadManualDocument,
    uploadContractDocumentVersion: core.uploadContractDocumentVersion,
    processingDocument: core.processingDocument,
    markDocumentTextProcessing: core.markDocumentTextProcessing,
    saveDocumentText: core.saveDocumentText,
    markDocumentTextProcessingFailed: core.markDocumentTextProcessingFailed,
    analysisDocument: core.analysisDocument,
    markDocumentAiProcessing: core.markDocumentAiProcessing,
    saveDocumentExtraction: core.saveDocumentExtraction,
    markDocumentAiProcessingFailed: core.markDocumentAiProcessingFailed,
    contractCard: core.contractCard,
    documentText: core.documentText,
  };
}
