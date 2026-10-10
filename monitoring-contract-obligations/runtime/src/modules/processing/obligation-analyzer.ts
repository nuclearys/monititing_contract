import { createDeepSeekExtractor } from '../ai/deepseek.js';

type AnalysisRepository = Readonly<{
  analysisDocument(documentId: string): Promise<{
    id: string;
    file_name: string;
    extracted_text: string | null;
    contract_number: string;
  } | null>;
  markDocumentAiProcessing(documentId: string): Promise<void>;
  saveDocumentExtraction(
    documentId: string,
    text: string,
    obligations: Awaited<ReturnType<ReturnType<typeof createDeepSeekExtractor>['extract']>>['obligations'],
    model: string,
  ): Promise<unknown>;
  markDocumentAiProcessingFailed(documentId: string, message: string): Promise<void>;
}>;

export function createObligationAnalyzer(repository: AnalysisRepository) {
  const extractor = createDeepSeekExtractor();

  return {
    async process(documentId: string) {
      const document = await repository.analysisDocument(documentId);
      if (!document) return null;
      await repository.markDocumentAiProcessing(documentId);
      try {
        if (!document.extracted_text?.trim()) throw new Error('Текст документа не извлечён.');
        const extracted = await extractor.extract(document.extracted_text, {
          contractNumber: document.contract_number,
          fileName: document.file_name,
        });
        return await repository.saveDocumentExtraction(documentId, document.extracted_text, extracted.obligations, extractor.model);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.markDocumentAiProcessingFailed(documentId, message);
        console.error(`Document AI analysis failed for ${documentId}: ${message}`);
        return null;
      }
    },
  };
}
