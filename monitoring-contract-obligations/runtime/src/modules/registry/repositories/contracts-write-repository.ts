import type { Pool } from 'pg';
import type { ExtractedObligation } from '../../ai/deepseek.js';
import type { ContractDocumentVersionInput, ManualDocumentInput } from '../types.js';

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
        const version = await client.query<{ next_version: number; previous_document_id: string | null }>(
          `
            SELECT
              COALESCE(MAX(document_version), 0) + 1 AS next_version,
              (ARRAY_AGG(id ORDER BY uploaded_at DESC))[1] AS previous_document_id
            FROM contract_documents
            WHERE contract_id = $1
              AND document_kind IN ('contract', 'annex', 'amendment')
          `,
          [contractId],
        );
        const documentVersion = Number(version.rows[0]?.next_version ?? 1);
        const previousDocumentId = version.rows[0]?.previous_document_id ?? null;
        if (input.documentKind !== 'evidence' && input.documentKind !== 'other') {
          await client.query(
            `
              UPDATE contract_documents
              SET is_current = false
              WHERE contract_id = $1
                AND document_kind IN ('contract', 'annex', 'amendment')
            `,
            [contractId],
          );
        }
        const document = await client.query<{ id: string }>(
          `
            INSERT INTO contract_documents (
              contract_id, file_name, storage_key, document_kind, mime_type,
              sha256, processing_status, uploaded_by, document_version,
              is_current, previous_document_id
            )
            VALUES ($1, $2, $3, $4::document_kind, $5, $6, 'queued', $7, $8, $9, $10)
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
            documentVersion,
            true,
            previousDocumentId,
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
            documentVersion,
            previousDocumentId,
          })],
        );
        await client.query('COMMIT');
        return {
          contractId,
          documentId: document.rows[0].id,
          processingStatus: 'queued',
          documentVersion,
          previousDocumentId,
          isNewVersion: Boolean(previousDocumentId),
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async uploadContractDocumentVersion(userId: string, contractId: string, input: ContractDocumentVersionInput) {
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
                WHERE user_id = $1 AND role IN ('lawyer', 'contract_manager', 'administrator')
              )
              AND EXISTS (SELECT 1 FROM contracts WHERE id = $2)
          `,
          [userId, contractId],
        );
        if (!permission.rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }
        const version = await client.query<{ next_version: number; previous_document_id: string | null }>(
          `
            SELECT
              COALESCE(MAX(document_version), 0) + 1 AS next_version,
              (ARRAY_AGG(id ORDER BY uploaded_at DESC))[1] AS previous_document_id
            FROM contract_documents
            WHERE contract_id = $1
              AND document_kind IN ('contract', 'annex', 'amendment')
          `,
          [contractId],
        );
        const documentVersion = Number(version.rows[0]?.next_version ?? 1);
        const previousDocumentId = version.rows[0]?.previous_document_id ?? null;
        await client.query(
          `
            UPDATE contract_documents
            SET is_current = false
            WHERE contract_id = $1
              AND document_kind IN ('contract', 'annex', 'amendment')
          `,
          [contractId],
        );
        const document = await client.query<{ id: string }>(
          `
            INSERT INTO contract_documents (
              contract_id, file_name, storage_key, document_kind, mime_type,
              sha256, processing_status, uploaded_by, document_version,
              is_current, previous_document_id
            )
            VALUES ($1, $2, $3, $4::document_kind, $5, $6, 'queued', $7, $8, true, $9)
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
            documentVersion,
            previousDocumentId,
          ],
        );
        await client.query(
          `
            UPDATE contracts
            SET processing_status = 'queued', verification_status = 'in_progress', updated_at = now()
            WHERE id = $1
          `,
          [contractId],
        );
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'contract_document', $2, 'contract_document_version_uploaded', $3::jsonb)
          `,
          [userId, document.rows[0].id, JSON.stringify({ contractId, fileName: input.fileName, fileSize: input.fileSize, documentVersion, previousDocumentId })],
        );
        await client.query('COMMIT');
        return {
          contractId,
          documentId: document.rows[0].id,
          processingStatus: 'queued',
          documentVersion,
          previousDocumentId,
          isNewVersion: Boolean(previousDocumentId),
        };
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
            c.contract_number,
            d.document_version,
            d.previous_document_id
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
        const document = await client.query<{
          contract_id: string;
          uploaded_by: string | null;
          document_version: number;
          previous_document_id: string | null;
        }>(
          `
            SELECT contract_id, uploaded_by, document_version, previous_document_id
            FROM contract_documents
            WHERE id = $1
            FOR UPDATE
          `,
          [documentId],
        );
        if (!document.rows[0]) throw new Error('Document not found during extraction.');
        const { contract_id: contractId, uploaded_by: uploadedBy, document_version: documentVersion, previous_document_id: previousDocumentId } = document.rows[0];
        const existing = await client.query<{
          id: string;
          code: string;
          title: string;
          description: string | null;
          responsible_party: string | null;
          due_date: string | null;
          amount: string | null;
          currency: string | null;
          obligation_type: string;
          sanction: string | null;
          risk_level: string | null;
          source_fragment: string | null;
          verification_status: string;
          version: number;
        }>(
          `
            SELECT id, code, title, description, responsible_party, due_date,
                   amount, currency, obligation_type, sanction, risk_level,
                   source_fragment, verification_status, version
            FROM obligations
            WHERE contract_id = $1
            ORDER BY code
            FOR UPDATE
          `,
          [contractId],
        );
        const existingByCode = new Map(existing.rows.map((row) => [row.code, row]));
        const extractedCodes = new Set<string>();
        const reviewItems: Array<{ obligationId: string; title: string; sourceFragment: string | null; changeType: 'new' | 'changed' | 'removed' }> = [];
        const valueKey = (value: unknown) => value === null || value === undefined ? null : String(value);

        for (const [index, item] of obligations.entries()) {
          const code = `AI-${String(index + 1).padStart(3, '0')}`;
          extractedCodes.add(code);
          const previous = existingByCode.get(code);
          const sourceLocator = JSON.stringify({ documentId, documentVersion, extractionModel: model });
          if (!previous) {
            const inserted = await client.query<{ id: string }>(
              `
                INSERT INTO obligations (
                  contract_id, source_document_id, code, title, description,
                  responsible_party, due_date, amount, currency, obligation_type,
                  sanction, risk_level, status, verification_status, execution_status,
                  confidence, source_fragment, source_text, source_locator, created_by
                )
                VALUES (
                  $1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10::obligation_type,
                  $11, $12, 'draft', 'pending', 'not_started', $13, $14, $15, $16::jsonb, $17
                )
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
                item.sanction ?? null,
                item.riskLevel ?? null,
                item.confidence ?? null,
                item.sourceFragment ?? null,
                item.sourceFragment ?? null,
                sourceLocator,
                uploadedBy,
              ],
            );
            reviewItems.push({ obligationId: inserted.rows[0].id, title: item.title, sourceFragment: item.sourceFragment ?? null, changeType: 'new' });
            continue;
          }

          const nextValues = {
            title: item.title,
            description: item.description ?? null,
            responsibleParty: item.responsibleParty ?? null,
            dueDate: item.dueDate ?? null,
            amount: item.amount ?? null,
            currency: item.currency ?? null,
            obligationType: item.obligationType,
            sanction: item.sanction ?? null,
            riskLevel: item.riskLevel ?? null,
            sourceFragment: item.sourceFragment ?? null,
          };
          const previousValues = {
            title: previous.title,
            description: previous.description,
            responsibleParty: previous.responsible_party,
            dueDate: previous.due_date,
            amount: previous.amount,
            currency: previous.currency,
            obligationType: previous.obligation_type,
            sanction: previous.sanction,
            riskLevel: previous.risk_level,
            sourceFragment: previous.source_fragment,
          };
          const changedFields = Object.fromEntries(
            Object.entries(nextValues).filter(([key, value]) => valueKey(value) !== valueKey(previousValues[key as keyof typeof previousValues])),
          );
          const changed = Object.keys(changedFields).length > 0;
          await client.query(
            `
              UPDATE obligations
              SET source_document_id = $2,
                  title = $3,
                  description = $4,
                  responsible_party = $5,
                  due_date = $6::date,
                  amount = $7,
                  currency = $8,
                  obligation_type = $9::obligation_type,
                  sanction = $10,
                  risk_level = $11,
                  confidence = $12,
                  source_fragment = $13,
                  source_text = $13,
                  source_locator = $14::jsonb,
                  verification_status = CASE WHEN $15::boolean THEN 'pending'::verification_status ELSE verification_status END,
                  status = CASE WHEN $15::boolean THEN 'draft'::obligation_status ELSE status END,
                  change_basis = CASE WHEN $15::boolean THEN $16 ELSE change_basis END,
                  version = CASE WHEN $15::boolean THEN version + 1 ELSE version END,
                  updated_at = now()
              WHERE id = $1
            `,
            [
              previous.id,
              documentId,
              item.title,
              item.description ?? null,
              item.responsibleParty ?? null,
              item.dueDate ?? null,
              item.amount ?? null,
              item.currency ?? null,
              item.obligationType,
              item.sanction ?? null,
              item.riskLevel ?? null,
              item.confidence ?? null,
              item.sourceFragment ?? null,
              sourceLocator,
              changed,
              `Изменено при обработке версии договора v${documentVersion}`,
            ],
          );
          if (changed) {
            await client.query(
              `
                INSERT INTO obligation_verification_events (
                  obligation_id, actor_user_id, action, previous_value, new_value, comment
                )
                VALUES ($1, $2, 'corrected', $3::jsonb, $4::jsonb, $5)
              `,
              [
                previous.id,
                uploadedBy,
                JSON.stringify({ version: previous.version, documentVersion, values: previousValues }),
                JSON.stringify({ version: previous.version + 1, documentVersion, changedFields }),
                `Источник обновлён: версия договора v${documentVersion}. Требуется повторная проверка юристом.`,
              ],
            );
            reviewItems.push({ obligationId: previous.id, title: item.title, sourceFragment: item.sourceFragment ?? null, changeType: 'changed' });
          }
        }

        for (const previous of existing.rows.filter((row) => !extractedCodes.has(row.code))) {
          await client.query(
            `
              INSERT INTO obligation_verification_events (
                obligation_id, actor_user_id, action, previous_value, new_value, comment
              )
              VALUES ($1, $2, 'corrected', $3::jsonb, $4::jsonb, $5)
            `,
            [
              previous.id,
              uploadedBy,
              JSON.stringify({ version: previous.version, documentVersion, values: { title: previous.title, sourceFragment: previous.source_fragment } }),
              JSON.stringify({ documentVersion, changeType: 'not_found_in_new_version' }),
              `Обязательство не найдено при обработке версии договора v${documentVersion}. Требуется проверка юристом.`,
            ],
          );
          reviewItems.push({ obligationId: previous.id, title: previous.title, sourceFragment: previous.source_fragment, changeType: 'removed' });
        }

        if (reviewItems.length) {
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
          for (const item of reviewItems) {
            const changeLabel = item.changeType === 'new' ? 'Новое обязательство' : item.changeType === 'removed' ? 'Проверить исключение обязательства' : 'Изменение обязательства';
            const activeTask = await client.query<{ id: string }>(
              `
                UPDATE review_tasks
                SET title = $2,
                    comment_text = $3,
                    quoted_text = $4,
                    source_locator = $5::jsonb,
                    status = 'open',
                    response_comment = NULL,
                    responded_by_user_id = NULL,
                    responded_at = NULL,
                    updated_at = now()
                WHERE obligation_id = $1
                  AND task_type = 'verification'
                  AND status IN ('open', 'in_progress')
                RETURNING id
              `,
              [
                item.obligationId,
                `${changeLabel}: «${item.title}»`,
                `Автоматическая задача после загрузки версии договора v${documentVersion}. Требуется проверить изменение обязательства и зафиксировать результат.`,
                item.sourceFragment,
                JSON.stringify({ documentId, documentVersion, previousDocumentId, changeType: item.changeType, extractionModel: model }),
              ],
            );
            if (activeTask.rows[0]) continue;
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
                item.obligationId,
                uploadedBy,
                lawyerUserId,
                `${changeLabel}: «${item.title}»`,
                `Автоматическая задача после загрузки версии договора v${documentVersion}. Требуется проверить изменение обязательства и зафиксировать результат.`,
                item.sourceFragment,
                JSON.stringify({ documentId, documentVersion, previousDocumentId, changeType: item.changeType, extractionModel: model }),
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
          [uploadedBy, documentId, JSON.stringify({ model, obligationsCount: obligations.length, documentVersion, previousDocumentId, changesForReview: reviewItems.length })],
        );
        await client.query('COMMIT');
        return { contractId, obligationsCount: obligations.length, model, documentVersion, changesForReview: reviewItems.length };
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
