import type { Pool } from 'pg';
import type { ExtractedObligation } from '../ai/deepseek.js';
import { visibilityCondition, reviewTaskVisibilityCondition } from './visibility.js';
import type { ExecutionUpdateInput, ManualDocumentInput, ObligationCommentInput, RegistryFilters, ReviewTaskUpdateInput, VerificationUpdateInput } from './types.js';

function addFilter(values: unknown[], expression: string, value: unknown): string {
  values.push(value);
  return `${expression} $${values.length}`;
}

function filterConditions(values: unknown[], filters: RegistryFilters): string[] {
  const conditions: string[] = [];
  if (filters.status)
    conditions.push(addFilter(values, 'r.obligation_status =', filters.status));
  if (filters.executionStatus)
    conditions.push(addFilter(values, 'r.execution_status =', filters.executionStatus));
  if (filters.verificationStatus)
    conditions.push(addFilter(values, 'r.verification_status =', filters.verificationStatus));
  if (filters.obligationType)
    conditions.push(addFilter(values, 'r.obligation_type =', filters.obligationType));
  if (filters.riskLevel)
    conditions.push(addFilter(values, 'r.risk_level =', filters.riskLevel));
  if (filters.responsibleParty)
    conditions.push(addFilter(values, 'r.responsible_party =', filters.responsibleParty));
  if (filters.originContour)
    conditions.push(addFilter(values, 'r.origin_contour =', filters.originContour));
  if (filters.dueFrom)
    conditions.push(addFilter(values, 'r.due_date >=', filters.dueFrom));
  if (filters.dueTo)
    conditions.push(addFilter(values, 'r.due_date <=', filters.dueTo));
  if (filters.overdue !== undefined)
    conditions.push(addFilter(values, 'r.is_overdue =', filters.overdue));
  return conditions;
}

export function createRegistryRepository(pool: Pool) {
  return {
    async dashboard(userId: string) {
      const result = await pool.query<{
        total_obligations: number;
        pending_verification_contracts: number;
        pending_verification: number;
        overdue_contracts: number;
        overdue: number;
        due_soon_contracts: number;
        due_soon: number;
        no_execution_contracts: number;
        no_execution: number;
        red_flags: number;
        contracts: number;
        contracts_on_review: number;
        users: number;
        audit_events: number;
        failed_processing: number;
        fco_pending: number;
        fco_pending_contracts: number;
        fco_accepted: number;
        fco_accepted_contracts: number;
        fco_rejected: number;
        fco_rejected_contracts: number;
      }>(
        `
          SELECT
            count(*)::int AS total_obligations,
            count(*) FILTER (WHERE r.verification_status = 'pending')::int AS pending_verification,
            count(DISTINCT r.contract_id) FILTER (WHERE r.verification_status = 'pending')::int AS pending_verification_contracts,
            count(*) FILTER (WHERE r.is_overdue)::int AS overdue,
            count(DISTINCT r.contract_id) FILTER (WHERE r.is_overdue)::int AS overdue_contracts,
            count(*) FILTER (
              WHERE r.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
                AND r.execution_status NOT IN ('completed', 'not_applicable')
            )::int AS due_soon,
            count(DISTINCT r.contract_id) FILTER (
              WHERE r.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
                AND r.execution_status NOT IN ('completed', 'not_applicable')
            )::int AS due_soon_contracts,
            count(*) FILTER (WHERE r.execution_status = 'not_started')::int AS no_execution,
            count(DISTINCT r.contract_id) FILTER (WHERE r.execution_status = 'not_started')::int AS no_execution_contracts,
            count(*) FILTER (WHERE lower(coalesce(r.risk_level, '')) IN ('high', 'critical', 'высокий', 'критический'))::int AS red_flags,
            count(DISTINCT r.contract_id)::int AS contracts,
            count(DISTINCT r.contract_id) FILTER (
              WHERE c.verification_status IN ('not_started', 'in_progress', 'needs_revision')
            )::int AS contracts_on_review,
            (SELECT count(*)::int FROM users WHERE is_active = true) AS users,
            (SELECT count(*)::int FROM audit_events) AS audit_events,
            count(DISTINCT r.contract_id) FILTER (WHERE c.processing_status = 'failed')::int AS failed_processing,
            count(*) FILTER (WHERE fr.id IS NULL)::int AS fco_pending,
            count(DISTINCT r.contract_id) FILTER (WHERE fr.id IS NULL)::int AS fco_pending_contracts,
            count(*) FILTER (WHERE fr.response_status = 'accepted')::int AS fco_accepted,
            count(DISTINCT r.contract_id) FILTER (WHERE fr.response_status = 'accepted')::int AS fco_accepted_contracts,
            count(*) FILTER (WHERE fr.response_status = 'rejected')::int AS fco_rejected,
            count(DISTINCT r.contract_id) FILTER (WHERE fr.response_status = 'rejected')::int AS fco_rejected_contracts
          FROM obligations_registry AS r
          JOIN contracts AS c ON c.id = r.contract_id
          LEFT JOIN LATERAL (
            SELECT response.id, response.response_status
            FROM fco_responses AS response
            WHERE response.obligation_id = r.obligation_id
            ORDER BY response.created_at DESC
            LIMIT 1
          ) AS fr ON true
          WHERE EXISTS (
            SELECT 1 FROM users AS viewer
            WHERE viewer.id = $1 AND viewer.is_active = true
          )
            AND ${visibilityCondition}
        `,
        [userId],
      );

      const row = result.rows[0];
      return {
        totalObligations: row?.total_obligations ?? 0,
        pendingVerificationContracts: row?.pending_verification_contracts ?? 0,
        pendingVerification: row?.pending_verification ?? 0,
        overdueContracts: row?.overdue_contracts ?? 0,
        overdue: row?.overdue ?? 0,
        dueSoonContracts: row?.due_soon_contracts ?? 0,
        dueSoon: row?.due_soon ?? 0,
        noExecutionContracts: row?.no_execution_contracts ?? 0,
        noExecution: row?.no_execution ?? 0,
        redFlags: row?.red_flags ?? 0,
        contracts: row?.contracts ?? 0,
        contractsOnReview: row?.contracts_on_review ?? 0,
        users: row?.users ?? 0,
        auditEvents: row?.audit_events ?? 0,
        failedProcessing: row?.failed_processing ?? 0,
        fcoPending: row?.fco_pending ?? 0,
        fcoPendingContracts: row?.fco_pending_contracts ?? 0,
        fcoAccepted: row?.fco_accepted ?? 0,
        fcoAcceptedContracts: row?.fco_accepted_contracts ?? 0,
        fcoRejected: row?.fco_rejected ?? 0,
        fcoRejectedContracts: row?.fco_rejected_contracts ?? 0,
      };
    },

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

    async updateExecution(userId: string, obligationId: string, input: ExecutionUpdateInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query<{ id: string; execution_status: string }>(
          `
            UPDATE obligations AS o
            SET execution_status = $3::execution_status,
                actual_execution_date = $4::date,
                overdue_reason = $5,
                overdue_comment = $6,
                execution_evidence_document_id = $7::uuid,
                overdue_requires_curator_input = false,
                updated_at = now()
            FROM contracts AS c
            WHERE o.id = $2
              AND o.contract_id = c.id
              AND EXISTS (
                SELECT 1 FROM users AS viewer
                WHERE viewer.id = $1 AND viewer.is_active = true
              )
              AND (
                EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'administrator')
                OR EXISTS (SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'deal_curator')
              )
              AND ${visibilityCondition}
              AND (
                $7::uuid IS NULL
                OR EXISTS (
                  SELECT 1 FROM contract_documents AS evidence
                  WHERE evidence.id = $7::uuid AND evidence.contract_id = o.contract_id
                )
              )
            RETURNING o.id, o.execution_status
          `,
          [
            userId,
            obligationId,
            input.status,
            input.actualExecutionDate ?? null,
            input.overdueReason ?? null,
            input.overdueComment ?? null,
            input.evidenceDocumentId ?? null,
          ],
        );

        if (!updated.rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }

        await client.query(
          `
            INSERT INTO obligation_execution_updates (
              obligation_id, actor_user_id, status, comment,
              evidence_document_id, actual_execution_date, overdue_reason
            )
            VALUES ($1, $2, $3::execution_status, $4, $5::uuid, $6::date, $7)
          `,
          [
            obligationId,
            userId,
            input.status,
            input.comment,
            input.evidenceDocumentId ?? null,
            input.actualExecutionDate ?? null,
            input.overdueReason ?? null,
          ],
        );
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'obligation', $2, 'execution_updated', $3::jsonb)
          `,
          [userId, obligationId, JSON.stringify(input)],
        );
        await client.query('COMMIT');
        return updated.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async addObligationComment(userId: string, obligationId: string, input: ObligationCommentInput) {
      const result = await pool.query<{
        id: string;
        contract_id: string;
        contract_number: string;
        obligation_title: string;
        curator_user_id: string | null;
      }>(
        `
          SELECT
            o.id,
            o.contract_id,
            c.contract_number,
            o.title AS obligation_title,
            c.curator_user_id
          FROM obligations AS o
          JOIN contracts AS c ON c.id = o.contract_id
          WHERE o.id = $2
            AND EXISTS (
              SELECT 1 FROM users AS viewer
              WHERE viewer.id = $1 AND viewer.is_active = true
            )
            AND EXISTS (
              SELECT 1 FROM user_roles AS commenter
              WHERE commenter.user_id = $1
                AND commenter.role IN ('lawyer', 'deal_curator', 'fco', 'contract_manager', 'administrator')
            )
            AND ${visibilityCondition}
        `,
        [userId, obligationId],
      );
      if (!result.rows[0]) return null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const event = await client.query<{ id: string; created_at: string }>(
          `
            INSERT INTO obligation_verification_events (
              obligation_id, actor_user_id, action, new_value, comment
            )
            VALUES ($1, $2, 'commented', $3::jsonb, $4)
            RETURNING id, created_at
          `,
          [obligationId, userId, JSON.stringify({ sourceLocator: input.sourceLocator ?? null }), input.comment],
        );
        const fallbackCurator = await client.query<{ id: string }>(
          `
            SELECT u.id
            FROM users AS u
            JOIN user_roles AS role ON role.user_id = u.id AND role.role = 'deal_curator'
            WHERE u.is_active = true
            ORDER BY u.created_at
            LIMIT 1
          `,
        );
        const assigneeUserId = result.rows[0].curator_user_id ?? fallbackCurator.rows[0]?.id ?? null;
        const quotedText = typeof input.sourceLocator?.selectedText === 'string'
          ? input.sourceLocator.selectedText
          : null;
        const task = await client.query<{ id: string; assignee_user_id: string | null }>(
          `
            INSERT INTO review_tasks (
              contract_id, obligation_id, comment_event_id, created_by_user_id,
              assignee_user_id, title, comment_text, quoted_text, source_locator
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
            RETURNING id, assignee_user_id
          `,
          [
            result.rows[0].contract_id,
            obligationId,
            event.rows[0].id,
            userId,
            assigneeUserId,
            `Проверить комментарий по обязательству «${result.rows[0].obligation_title}»`,
            input.comment,
            quotedText,
            JSON.stringify(input.sourceLocator ?? null),
          ],
        );
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'obligation', $2, 'comment_added', $3::jsonb)
          `,
          [userId, obligationId, JSON.stringify({ sourceLocator: input.sourceLocator ?? null, taskId: task.rows[0].id })],
        );
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'review_task', $2, 'review_task_created', $3::jsonb)
          `,
          [userId, task.rows[0].id, JSON.stringify({ obligationId, assigneeUserId })],
        );
        await client.query('COMMIT');
        return {
          id: event.rows[0].id,
          createdAt: event.rows[0].created_at,
          taskId: task.rows[0].id,
          assigneeUserId: task.rows[0].assignee_user_id,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async obligationComments(userId: string, obligationId: string) {
      const result = await pool.query(
        `
          SELECT
            event.id,
            event.comment,
            event.new_value AS source,
            event.created_at,
            actor.full_name AS author
          FROM obligation_verification_events AS event
          JOIN obligations AS o ON o.id = event.obligation_id
          JOIN contracts AS c ON c.id = o.contract_id
          LEFT JOIN users AS actor ON actor.id = event.actor_user_id
          WHERE event.obligation_id = $2
            AND event.action = 'commented'
            AND EXISTS (
              SELECT 1 FROM users AS viewer
              WHERE viewer.id = $1 AND viewer.is_active = true
            )
            AND ${visibilityCondition}
          ORDER BY event.created_at DESC
        `,
        [userId, obligationId],
      );
      return result.rows;
    },

    async reviewTaskGroups(userId: string, status?: string, dueScope?: string) {
      const result = await pool.query(
        `
          SELECT
            task.contract_id,
            contract.contract_number,
            contract.title AS contract_title,
            min(obligation.due_date) AS due_date,
            count(*)::int AS obligation_count,
            count(*) FILTER (WHERE obligation.verification_status = 'pending')::int AS pending_count,
            count(*) FILTER (WHERE obligation.verification_status = 'confirmed')::int AS confirmed_count,
            count(*) FILTER (WHERE obligation.verification_status = 'corrected')::int AS corrected_count,
            count(*) FILTER (WHERE task.status = 'in_progress')::int AS in_progress_count,
            min(task.created_at) AS created_at,
            CASE
              WHEN count(*) FILTER (WHERE obligation.verification_status = 'pending') = 0
                AND count(*) FILTER (WHERE obligation.verification_status = 'corrected') > 0 THEN 'needs_revision'
              WHEN count(*) FILTER (WHERE obligation.verification_status = 'pending') = 0 THEN 'completed'
              WHEN count(*) FILTER (WHERE task.status = 'in_progress') > 0 THEN 'in_progress'
              ELSE 'open'
            END AS task_status
          FROM review_tasks AS task
          JOIN contracts AS contract ON contract.id = task.contract_id
          JOIN obligations AS obligation ON obligation.id = task.obligation_id
          WHERE task.task_type = 'verification'
            AND EXISTS (
              SELECT 1 FROM users AS viewer
              WHERE viewer.id = $1 AND viewer.is_active = true
            )
            AND (
              task.assignee_user_id = $1
              OR task.created_by_user_id = $1
              OR EXISTS (
                SELECT 1 FROM user_roles AS admin_role
                WHERE admin_role.user_id = $1 AND admin_role.role = 'administrator'
              )
              OR (
                EXISTS (
                  SELECT 1 FROM user_roles AS lawyer_role
                  WHERE lawyer_role.user_id = $1 AND lawyer_role.role = 'lawyer'
                )
                AND ${reviewTaskVisibilityCondition}
              )
            )
          GROUP BY task.contract_id, contract.contract_number, contract.title
          HAVING ($2::text IS NULL OR (
              CASE
                WHEN count(*) FILTER (WHERE obligation.verification_status = 'pending') = 0
                  AND count(*) FILTER (WHERE obligation.verification_status = 'corrected') > 0 THEN 'needs_revision'
                WHEN count(*) FILTER (WHERE obligation.verification_status = 'pending') = 0 THEN 'completed'
                WHEN count(*) FILTER (WHERE task.status = 'in_progress') > 0 THEN 'in_progress'
                ELSE 'open'
              END
            ) = $2::text)
            AND (
              $3::text IS NULL
              OR ($3::text = 'today' AND min(obligation.due_date) <= CURRENT_DATE)
              OR ($3::text = 'upcoming' AND min(obligation.due_date) > CURRENT_DATE AND min(obligation.due_date) <= CURRENT_DATE + 14)
              OR ($3::text = 'no_due' AND count(obligation.due_date) = 0)
            )
          ORDER BY CASE
                     WHEN min(obligation.due_date) IS NULL THEN 1
                     WHEN min(obligation.due_date) < CURRENT_DATE THEN 0
                     ELSE 0
                   END,
                   min(obligation.due_date) NULLS LAST,
                   min(task.created_at) DESC
        `,
        [userId, status ?? null, dueScope ?? null],
      );
      return result.rows;
    },

    async reviewTaskGroup(userId: string, contractId: string) {
      const result = await pool.query(
        `
          SELECT
            task.id AS task_id,
            task.contract_id,
            task.obligation_id,
            task.status AS task_status,
            task.response_comment,
            task.created_at,
            contract.contract_number,
            contract.title AS contract_title,
            obligation.code,
            obligation.title AS obligation_title,
            obligation.description,
            obligation.source_fragment,
            obligation.source_locator,
            obligation.due_date,
            obligation.verification_status,
            obligation.execution_status,
            latest_event.comment AS verification_comment
          FROM review_tasks AS task
          JOIN contracts AS contract ON contract.id = task.contract_id
          JOIN obligations AS obligation ON obligation.id = task.obligation_id
          LEFT JOIN LATERAL (
            SELECT event.comment
            FROM obligation_verification_events AS event
            WHERE event.obligation_id = obligation.id
              AND event.action IN ('confirmed', 'corrected', 'rejected')
            ORDER BY event.created_at DESC
            LIMIT 1
          ) AS latest_event ON true
          WHERE task.task_type = 'verification'
            AND task.contract_id = $2
            AND EXISTS (
              SELECT 1 FROM users AS viewer
              WHERE viewer.id = $1 AND viewer.is_active = true
            )
            AND (
              task.assignee_user_id = $1
              OR task.created_by_user_id = $1
              OR EXISTS (
                SELECT 1 FROM user_roles AS admin_role
                WHERE admin_role.user_id = $1 AND admin_role.role = 'administrator'
              )
              OR (
                task.task_type = 'verification'
                AND EXISTS (
                  SELECT 1 FROM user_roles AS lawyer_role
                  WHERE lawyer_role.user_id = $1 AND lawyer_role.role = 'lawyer'
                )
                AND ${reviewTaskVisibilityCondition}
              )
            )
          ORDER BY obligation.due_date NULLS LAST, obligation.code
        `,
        [userId, contractId],
      );
      return result.rows;
    },

    async updateObligationVerification(userId: string, obligationId: string, input: VerificationUpdateInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const obligation = await client.query<{
          id: string;
          contract_id: string;
          contract_number: string;
          title: string;
          source_fragment: string | null;
          curator_user_id: string | null;
        }>(
          `
            SELECT o.id, o.contract_id, c.contract_number, o.title, o.source_fragment, c.curator_user_id
            FROM obligations AS o
            JOIN contracts AS c ON c.id = o.contract_id
            WHERE o.id = $2
              AND EXISTS (
                SELECT 1 FROM users AS viewer
                WHERE viewer.id = $1 AND viewer.is_active = true
              )
              AND EXISTS (
                SELECT 1 FROM user_roles AS lawyer
                WHERE lawyer.user_id = $1 AND lawyer.role IN ('lawyer', 'administrator')
              )
              AND ${visibilityCondition}
            FOR UPDATE
          `,
          [userId, obligationId],
        );
        if (!obligation.rows[0]) return null;
        const comment = input.comment?.trim() || null;
        if (input.status === 'corrected' && !comment) {
          throw new Error('Для статуса «Нужно исправить» нужен комментарий.');
        }
        await client.query(
          `
            UPDATE obligations
            SET verification_status = $2::verification_status,
                status = CASE WHEN $2::verification_status = 'corrected' THEN 'draft'::obligation_status ELSE 'confirmed'::obligation_status END,
                execution_status = CASE WHEN $3::boolean THEN 'not_applicable'::execution_status ELSE execution_status END,
                updated_at = now()
            WHERE id = $1
          `,
          [obligationId, input.status, input.executionNotRequired === true],
        );
        await client.query(
          `
            INSERT INTO obligation_verification_events (obligation_id, actor_user_id, action, new_value, comment)
            VALUES ($1, $2, $3, $4::jsonb, $5)
          `,
          [obligationId, userId, input.status, JSON.stringify({ executionNotRequired: input.executionNotRequired === true }), comment],
        );
        await client.query(
          `
            UPDATE review_tasks
            SET status = 'completed',
                response_comment = COALESCE($3, response_comment),
                responded_by_user_id = $1,
                responded_at = now(),
                updated_at = now()
            WHERE obligation_id = $2 AND task_type = 'verification'
          `,
          [userId, obligationId, comment],
        );
        let commentTaskId: string | null = null;
        if (input.status === 'corrected') {
          const fallbackCurator = await client.query<{ id: string }>(
            `
              SELECT u.id
              FROM users AS u
              JOIN user_roles AS role ON role.user_id = u.id AND role.role = 'deal_curator'
              WHERE u.is_active = true
              ORDER BY u.created_at
              LIMIT 1
            `,
          );
          const assigneeUserId = obligation.rows[0].curator_user_id ?? fallbackCurator.rows[0]?.id ?? null;
          const event = await client.query<{ id: string }>(
            `
              INSERT INTO obligation_verification_events (obligation_id, actor_user_id, action, new_value, comment)
              VALUES ($1, $2, 'commented', $3::jsonb, $4)
              RETURNING id
            `,
            [obligationId, userId, JSON.stringify({ reason: 'verification_correction' }), comment],
          );
          const task = await client.query<{ id: string }>(
            `
              INSERT INTO review_tasks (
                contract_id, obligation_id, comment_event_id, created_by_user_id, assignee_user_id,
                task_type, title, comment_text, quoted_text, source_locator
              )
              VALUES ($1, $2, $3, $4, $5, 'comment_response', $6, $7, $8, $9::jsonb)
              RETURNING id
            `,
            [
              obligation.rows[0].contract_id,
              obligationId,
              event.rows[0].id,
              userId,
              assigneeUserId,
              `Исправить замечание по обязательству «${obligation.rows[0].title}»`,
              comment,
              obligation.rows[0].source_fragment,
              JSON.stringify({ reason: 'verification_correction' }),
            ],
          );
          commentTaskId = task.rows[0].id;
        }
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'obligation', $2, 'verification_updated', $3::jsonb)
          `,
          [userId, obligationId, JSON.stringify({ status: input.status, executionNotRequired: input.executionNotRequired === true, commentTaskId })],
        );
        await client.query('COMMIT');
        return { obligationId, status: input.status, commentTaskId };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async reviewTasks(userId: string, status?: string, taskType?: string, dueScope?: string) {
      const result = await pool.query(
        `
          SELECT
            task.id,
            task.contract_id,
            task.obligation_id,
            task.title,
            task.comment_text,
            task.quoted_text,
            task.source_locator,
            task.task_type,
            task.status,
            task.assignee_user_id,
            task.response_comment,
            task.responded_at,
            task.created_at,
            contract.contract_number,
            contract.title AS contract_title,
            obligation.title AS obligation_title,
            obligation.due_date,
            creator.full_name AS creator_name,
            assignee.full_name AS assignee_name
          FROM review_tasks AS task
          JOIN contracts AS contract ON contract.id = task.contract_id
          LEFT JOIN obligations AS obligation ON obligation.id = task.obligation_id
          LEFT JOIN users AS creator ON creator.id = task.created_by_user_id
          LEFT JOIN users AS assignee ON assignee.id = task.assignee_user_id
          WHERE EXISTS (
            SELECT 1 FROM users AS viewer
            WHERE viewer.id = $1 AND viewer.is_active = true
          )
            AND (
              task.assignee_user_id = $1
              OR task.created_by_user_id = $1
              OR EXISTS (
                SELECT 1 FROM user_roles AS admin_role
                WHERE admin_role.user_id = $1 AND admin_role.role = 'administrator'
              )
            )
            AND ($2::review_task_status IS NULL OR task.status = $2::review_task_status)
            AND ($3::text IS NULL OR task.task_type = $3::text)
            AND (
              $4::text IS NULL
              OR ($4::text = 'today' AND obligation.due_date <= CURRENT_DATE)
              OR ($4::text = 'upcoming' AND obligation.due_date > CURRENT_DATE AND obligation.due_date <= CURRENT_DATE + 14)
              OR ($4::text = 'no_due' AND obligation.due_date IS NULL)
            )
          ORDER BY CASE task.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
                   obligation.due_date NULLS LAST,
                   task.created_at DESC
        `,
        [userId, status ?? null, taskType ?? null, dueScope ?? null],
      );
      return result.rows;
    },

    async updateReviewTask(userId: string, taskId: string, input: ReviewTaskUpdateInput) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `
            UPDATE review_tasks AS task
            SET status = $3::review_task_status,
                response_comment = COALESCE($4, task.response_comment),
                responded_by_user_id = CASE
                  WHEN $3::review_task_status IN ('completed', 'declined') THEN $1
                  ELSE task.responded_by_user_id
                END,
                responded_at = CASE
                  WHEN $3::review_task_status IN ('completed', 'declined') THEN now()
                  ELSE task.responded_at
                END,
                updated_at = now()
            WHERE task.id = $2
              AND (
                task.assignee_user_id = $1
                OR EXISTS (
                  SELECT 1 FROM user_roles AS admin_role
                  WHERE admin_role.user_id = $1 AND admin_role.role = 'administrator'
                )
              )
            RETURNING task.id, task.status, task.response_comment, task.responded_at
          `,
          [userId, taskId, input.status, input.responseComment ?? null],
        );
        if (!updated.rows[0]) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query(
          `
            INSERT INTO audit_events (actor_user_id, entity_type, entity_id, action, payload)
            VALUES ($1, 'review_task', $2, 'review_task_updated', $3::jsonb)
          `,
          [userId, taskId, JSON.stringify(input)],
        );
        await client.query('COMMIT');
        return updated.rows[0];
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async list(userId: string, filters: RegistryFilters) {
      const values: unknown[] = [userId];
      const conditions = [
        `EXISTS (
          SELECT 1 FROM users AS viewer
          WHERE viewer.id = $1 AND viewer.is_active = true
        )`,
        visibilityCondition,
        ...filterConditions(values, filters),
      ];
      const where = conditions.map((condition) => `(${condition})`).join(' AND ');
      const sortColumn = {
        due_date: 'r.due_date',
        updated_at: 'r.updated_at',
        contract_number: 'r.contract_number',
        risk_level: 'r.risk_level',
      }[filters.sort];
      const offset = (filters.page - 1) * filters.pageSize;
      const countResult = await pool.query<{ total: number }>(
        `
          SELECT count(*)::int AS total
          FROM obligations_registry AS r
          JOIN contracts AS c ON c.id = r.contract_id
          WHERE ${where}
        `,
        values,
      );
      const rows = await pool.query(
        `
          SELECT r.*
          FROM obligations_registry AS r
          JOIN contracts AS c ON c.id = r.contract_id
          WHERE ${where}
          ORDER BY ${sortColumn} ${filters.direction.toUpperCase()}, r.obligation_id
          LIMIT $${values.length + 1}
          OFFSET $${values.length + 2}
        `,
        [...values, filters.pageSize, offset],
      );

      return {
        items: rows.rows,
        total: countResult.rows[0]?.total ?? 0,
        page: filters.page,
        pageSize: filters.pageSize,
      };
    },

    async contractCard(userId: string, contractId: string) {
      const result = await pool.query(
        `
          SELECT card.*
          FROM contract_card AS card
          JOIN contracts AS c ON c.id = card.contract_id
          WHERE card.contract_id = $2
            AND EXISTS (
              SELECT 1 FROM users AS viewer
              WHERE viewer.id = $1 AND viewer.is_active = true
            )
            AND ${visibilityCondition}
        `,
        [userId, contractId],
      );
      if (!result.rows[0]) return null;
      const obligations = await pool.query(
        `
          SELECT
            o.id AS obligation_id,
            o.code,
            o.title AS obligation_subject,
            o.verification_status,
            o.execution_status,
            o.due_date,
            o.source_document_id,
            o.source_fragment
          FROM obligations AS o
          JOIN contracts AS c ON c.id = o.contract_id
          WHERE o.contract_id = $2
            AND ${visibilityCondition}
          ORDER BY o.due_date NULLS LAST, o.code
        `,
        [userId, contractId],
      );
      return { ...result.rows[0], obligations: obligations.rows };
    },

    async documentText(userId: string, documentId: string) {
      const result = await pool.query(
        `
          SELECT
            d.id,
            d.file_name,
            d.document_version,
            d.processing_status,
            d.extracted_text,
            d.processed_at
          FROM contract_documents AS d
          JOIN contracts AS c ON c.id = d.contract_id
          WHERE d.id = $2
            AND EXISTS (
              SELECT 1 FROM users AS viewer
              WHERE viewer.id = $1 AND viewer.is_active = true
            )
            AND ${visibilityCondition}
        `,
        [userId, documentId],
      );
      return result.rows[0] ?? null;
    },
  };
}

export type { RegistryFilters } from './types.js';
