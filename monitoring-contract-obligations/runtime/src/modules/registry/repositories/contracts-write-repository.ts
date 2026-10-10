import type { Pool } from 'pg';
import type { ExtractedObligation } from '../../ai/deepseek.js';
import type { ManualDocumentInput } from '../types.js';

export function createContractWriteRepository(pool: Pool) {
  return {
    async uploadManualDocument(userId: string, input: ManualDocumentInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const permission = await client.query(
          `
            SELECT 1
            FROM users AS u
            WHERE u.id = $1 AND u.is_active = true
              AND EXISTS (
                SELECT 1 FROM user_roles
                WHERE user_id = $1 AND role IN ('contract_manager', 'administrator')
              )
          `,
          [userId],
        );
        if (!permission.rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }

        const contract = await client.query<{ id: string }>(
          `
            INSERT INTO contracts (
              contract_number, title, counterparty_name, contract_date,
              source_system, processing_status, verification_status
            )
            VALUES ($1, $2, $3, $4::date, 'manual', 'queued', 'not_started')
            ON CONFLICT (contract_number)
            DO UPDATE SET
              title = EXCLUDED.title,
              counterparty_name = EXCLUDED.counterparty_name,
              contract_date = COALESCE(EXCLUDED.contract_date, contracts.contract_date),
              source_system = 'manual',
              processing_status = 'queued',
              updated_at = now()
            RETURNING id
          `,
          [input.contractNumber, input.title, input.counterpartyName, input.contractDate ?? null],
        );
        const contractId = contract.rows[0].id;
        const document = await client.query<{ id: string }>(
          `
            INSERT INTO contract_documents (
              contract_id, file_name, storage_key, document_kind, mime_type,
              sha256, processing_status, uploaded_by
            )
            VALUES ($1, $2, $3, $4::document_kind, $5, $6, 'queued', $7)
            RETURNING id
          `,
          [
            contractId,
            input.fileName,
            input.storageKey,
            input.documentKind,
            input.mimeType,
            input.sha256,
            userId,
          ],
        );
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'contract_document', $2, 'manual_document_uploaded', $3::jsonb)
          `,
          [userId, document.rows[0].id, JSON.stringify({
            contractId,
            fileName: input.fileName,
            fileSize: input.fileSize,
            sourceSystem: 'manual',
          })],
        );
        await client.query('COMMIT');
        return { contractId, documentId: document.rows[0].id, processingStatus: 'queued' };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async processingDocument(documentId: string) {
      const result = await pool.query(
        `
          SELECT
            d.id,
            d.file_name,
            d.storage_key,
            d.mime_type,
            d.uploaded_by,
            c.id AS contract_id,
            c.contract_number
          FROM contract_documents AS d
          JOIN contracts AS c ON c.id = d.contract_id
          WHERE d.id = $1
        `,
        [documentId],
      );
      return result.rows[0] ?? null;
    },

    async markDocumentProcessing(documentId: string) {
      await pool.query(
        `UPDATE contract_documents SET processing_status = 'processing' WHERE id = $1`,
        [documentId],
      );
      await pool.query(
        `
          UPDATE contracts
          SET processing_status = 'processing', updated_at = now()
          WHERE id = (SELECT contract_id FROM contract_documents WHERE id = $1)
        `,
        [documentId],
      );
    },

    async saveDocumentExtraction(documentId: string, extractedText: string, obligations: ExtractedObligation[], model: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const document = await client.query<{ contract_id: string; uploaded_by: string | null }>(
          `SELECT contract_id, uploaded_by FROM contract_documents WHERE id = $1 FOR UPDATE`,
          [documentId],
        );
        if (!document.rows[0]) throw new Error('Document not found during extraction.');
        const { contract_id: contractId, uploaded_by: uploadedBy } = document.rows[0];
        const extractedObligationIds: string[] = [];

        await client.query(
          `DELETE FROM obligations WHERE source_document_id = $1 AND verification_status = 'pending'`,
          [documentId],
        );
        for (const [index, item] of obligations.entries()) {
          const code = `AI-${String(index + 1).padStart(3, '0')}`;
          const savedObligation = await client.query<{ id: string }>(
            `
              INSERT INTO obligations (
                contract_id, source_document_id, code, title, description,
                responsible_party, due_date, amount, currency, obligation_type,
                status, verification_status, execution_status, confidence,
                source_fragment, source_text, source_locator, created_by
              )
              VALUES (
                $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10::obligation_type,
                'draft', 'pending', 'not_started', $11, $12, $13, $14::jsonb, $15
              )
              ON CONFLICT (contract_id, code)
              DO UPDATE SET
                source_document_id = EXCLUDED.source_document_id,
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                responsible_party = EXCLUDED.responsible_party,
                due_date = EXCLUDED.due_date,
                amount = EXCLUDED.amount,
                currency = EXCLUDED.currency,
                obligation_type = EXCLUDED.obligation_type,
                verification_status = 'pending',
                confidence = EXCLUDED.confidence,
                source_fragment = EXCLUDED.source_fragment,
                source_text = EXCLUDED.source_text,
                source_locator = EXCLUDED.source_locator,
                updated_at = now()
              RETURNING id
            `,
            [
              contractId,
              documentId,
              code,
              item.title,
              item.description ?? null,
              item.responsibleParty ?? null,
              item.dueDate ?? null,
              item.amount ?? null,
              item.currency ?? null,
              item.obligationType,
              item.confidence ?? null,
              item.sourceFragment ?? null,
              item.sourceFragment ?? null,
              JSON.stringify({ documentId, extractionModel: model }),
              uploadedBy,
            ],
          );
          extractedObligationIds.push(savedObligation.rows[0].id);
        }
        if (extractedObligationIds.length) {
          const lawyer = await client.query<{ id: string }>(
            `
              SELECT u.id
              FROM users AS u
              JOIN user_roles AS role ON role.user_id = u.id AND role.role = 'lawyer'
              WHERE u.is_active = true
              ORDER BY u.created_at
              LIMIT 1
            `,
          );
          const lawyerUserId = lawyer.rows[0]?.id ?? null;
          for (const [index, obligationId] of extractedObligationIds.entries()) {
            const item = obligations[index];
            await client.query(
              `
                INSERT INTO review_tasks (
                  contract_id, obligation_id, created_by_user_id, assignee_user_id,
                  task_type, title, comment_text, quoted_text, source_locator
                )
                VALUES ($1, $2, $3, $4, 'verification', $5, $6, $7, $8::jsonb)
                ON CONFLICT DO NOTHING
              `,
              [
                contractId,
                obligationId,
                uploadedBy,
                lawyerUserId,
                `Проверить извлечённое обязательство «${item.title}»`,
                'Автоматическая задача: проверить обязательство, извлечённое из текста договора.',
                item.sourceFragment ?? null,
                JSON.stringify({ documentId, extractionModel: model }),
              ],
            );
          }
        }
        await client.query(
          `
            UPDATE contract_documents
            SET extracted_text = $2, processing_status = 'ready', processed_at = now()
            WHERE id = $1
          `,
          [documentId, extractedText],
        );
        await client.query(
          `
            UPDATE contracts
            SET processing_status = 'ready_for_review',
                verification_status = 'in_progress',
                updated_at = now()
            WHERE id = $1
          `,
          [contractId],
        );
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'contract_document', $2, 'ai_extraction_completed', $3::jsonb)
          `,
          [uploadedBy, documentId, JSON.stringify({ model, obligationsCount: obligations.length })],
        );
        await client.query('COMMIT');
        return { contractId, obligationsCount: obligations.length, model };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async markDocumentProcessingFailed(documentId: string, message: string) {
      await pool.query(`UPDATE contract_documents SET processing_status = 'failed' WHERE id = $1`, [documentId]);
      await pool.query(
        `
          UPDATE contracts
          SET processing_status = 'failed', updated_at = now()
          WHERE id = (SELECT contract_id FROM contract_documents WHERE id = $1)
        `,
        [documentId],
      );
      await pool.query(
        `
          INSERT INTO audit_events (entity_type, entity_id, action, payload)
          VALUES ('contract_document', $1, 'ai_extraction_failed', $2::jsonb)
        `,
        [documentId, JSON.stringify({ message: message.slice(0, 1000) })],
      );
    },
  };
}

