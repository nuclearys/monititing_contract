import type { Pool } from 'pg';
import { visibilityCondition } from '../visibility.js';
import type { ExecutionUpdateInput, VerificationUpdateInput } from '../types.js';

export function createObligationWriteRepository(pool: Pool) {
  return {
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
  };
}
