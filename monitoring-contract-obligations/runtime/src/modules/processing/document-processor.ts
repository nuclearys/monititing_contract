import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ObjectStorage } from '../../infrastructure/object-storage.js';

const execFile = promisify(execFileCallback);

type ProcessingRepository = Readonly<{
  processingDocument(documentId: string): Promise<{
    id: string;
    file_name: string;
    storage_key: string;
    mime_type: string;
    contract_number: string;
  } | null>;
  markDocumentTextProcessing(documentId: string): Promise<void>;
  saveDocumentText(documentId: string, text: string): Promise<unknown>;
  markDocumentTextProcessingFailed(documentId: string, message: string): Promise<void>;
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

async function extractText(storage: ObjectStorage, storageKey: string, mimeType: string): Promise<string> {
  const materialized = await storage.materialize(storageKey);
  const filePath = materialized.filePath;
  try {
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
  } finally {
    await materialized.cleanup();
  }
}

export function createDocumentProcessor(repository: ProcessingRepository, storage: ObjectStorage) {
  return {
    async process(documentId: string) {
      const document = await repository.processingDocument(documentId);
      if (!document) return null;
      await repository.markDocumentTextProcessing(documentId);
      try {
        const text = await extractText(storage, document.storage_key, document.mime_type);
        return await repository.saveDocumentText(documentId, text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.markDocumentTextProcessingFailed(documentId, message);
        console.error(`Document text extraction failed for ${documentId}: ${message}`);
        return null;
      }
    },
  };
}
