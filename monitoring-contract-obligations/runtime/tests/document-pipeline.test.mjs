import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDocumentProcessor } from '../src/modules/processing/document-processor.ts';

test('document worker extracts text locally and leaves AI analysis as a separate stage', async () => {
  const repositoryCalls = [];
  const repository = {
    async processingDocument() {
      return {
        id: 'document-1',
        file_name: 'contract.docx',
        storage_key: 'contract.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contract_number: 'TEST-001',
      };
    },
    async markDocumentTextProcessing(documentId) {
      repositoryCalls.push(['processing', documentId]);
    },
    async saveDocumentText(documentId, text) {
      repositoryCalls.push(['saved', documentId, text]);
      return { aiStatus: 'queued' };
    },
    async markDocumentTextProcessingFailed(documentId, message) {
      repositoryCalls.push(['failed', documentId, message]);
    },
  };
  const storage = {
    async materialize() {
      return {
        filePath: fileURLToPath(new URL('../../test-data/Договор_для_проверки_извлечения.docx', import.meta.url)),
        async cleanup() {},
      };
    },
  };

  const result = await createDocumentProcessor(repository, storage).process('document-1');

  assert.equal(result.aiStatus, 'queued');
  assert.equal(repositoryCalls[0][0], 'processing');
  assert.equal(repositoryCalls[1][0], 'saved');
  assert.match(repositoryCalls[1][2], /обязуется|обязан/i);
  assert.equal(repositoryCalls.some(([action]) => action === 'failed'), false);
});
