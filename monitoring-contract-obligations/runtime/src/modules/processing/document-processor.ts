import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createDeepSeekExtractor } from '../ai/deepseek.js';

const execFile = promisify(execFileCallback);

type ProcessingRepository = Readonly<{
  processingDocument(documentId: string): Promise<{
    id: string;
    file_name: string;
    storage_key: string;
    mime_type: string;
    contract_number: string;
  } | null>;
  markDocumentProcessing(documentId: string): Promise<void>;
  saveDocumentExtraction(documentId: string, text: string, obligations: Awaited<ReturnType<ReturnType<typeof createDeepSeekExtractor>['extract']>>['obligations'], model: string): Promise<unknown>;
  markDocumentProcessingFailed(documentId: string, message: string): Promise<void>;
}>;

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\s*\/?>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractText(storageDirectory: string, storageKey: string, mimeType: string): Promise<string> {
  const filePath = join(storageDirectory, storageKey);
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || storageKey.toLowerCase().endsWith('.docx')) {
    const result = await execFile('/usr/bin/unzip', ['-p', filePath, 'word/document.xml'], { maxBuffer: 25 * 1024 * 1024 });
    return decodeXmlText(result.stdout);
  }
  if (mimeType === 'application/pdf' || storageKey.toLowerCase().endsWith('.pdf')) {
    const result = await execFile('/usr/bin/pdftotext', [filePath, '-'], { maxBuffer: 25 * 1024 * 1024 });
    return result.stdout.trim();
  }
  if (mimeType.startsWith('text/')) return (await readFile(filePath, 'utf8')).trim();
  throw new Error('Поддерживаются DOCX, PDF и текстовые документы.');
}

export function createDocumentProcessor(repository: ProcessingRepository, storageDirectory: string) {
  const extractor = createDeepSeekExtractor();

  return {
    async process(documentId: string) {
      const document = await repository.processingDocument(documentId);
      if (!document) return null;
      await repository.markDocumentProcessing(documentId);
      try {
        const text = await extractText(storageDirectory, document.storage_key, document.mime_type);
        const extracted = await extractor.extract(text, {
          contractNumber: document.contract_number,
          fileName: document.file_name,
        });
        return await repository.saveDocumentExtraction(documentId, text, extracted.obligations, extractor.model);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.markDocumentProcessingFailed(documentId, message);
        console.error(`Document processing failed for ${documentId}: ${message}`);
        return null;
      }
    },
  };
}
