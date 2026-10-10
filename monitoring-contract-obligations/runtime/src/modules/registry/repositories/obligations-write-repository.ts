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
          description: string | null;
          responsible_party: string | null;
          due_date: string | null;
          obligation_type: string;
          sanction: string | null;
          risk_level: string | null;
          source_fragment: string | null;
          curator_user_id: string | null;
          version: number;
        }>(
          `
            SELECT o.id, o.contract_id, c.contract_number, o.title, o.description,
                   o.responsible_party, o.due_date, o.obligation_type, o.sanction,
                   o.risk_level, o.source_fragment, c.curator_user_id, o.version
            FROM obligations AS o
            JOIN contracts AS c ON c.id = o.contract_id
            WHERE o.id = $2
              AND EXISTS (
                SELECT 1 FROM users AS viewer
                WHERE viewer.id = $1 AND viewer.is_active = true
              )
              AND EXISTS (
                SELECT 1 FROM user_roles AS editor
                WHERE editor.user_id = $1
                  AND editor.role IN ('lawyer', 'deal_curator', 'contract_manager')
              )
              AND ${visibilityCondition}
            FOR UPDATE
          `,
          [userId, obligationId],
        );
        if (!obligation.rows[0]) return null;
        const comment = input.comment?.trim() || null;
        if (input.status !== 'confirmed' && !comment) {
          throw new Error('Для исправления или отклонения нужен комментарий.');
        }
        if (input.title !== undefined && !input.title.trim()) {
          throw new Error('Наименование обязательства не может быть пустым.');
        }
        const changedFields: Record<string, unknown> = {};
        const params: unknown[] = [
          obligationId,
          input.status,
          input.status === 'rejected' ? 'rejected' : input.status === 'corrected' ? 'draft' : 'confirmed',
          input.executionNotRequired === true,
          userId,
          comment,
        ];
        const updates = [
          'verification_status = $2::verification_status',
          'status = $3::obligation_status',
          "execution_status = CASE WHEN $4::boolean THEN 'not_applicable'::execution_status ELSE execution_status END",
          'verified_by_user_id = $5',
          'verified_at = now()',
          'user_comment = COALESCE($6, user_comment)',
          'change_basis = COALESCE($6, change_basis)',
        ];
        const setOptional = (column: string, value: unknown, cast = '') => {
          if (value === undefined) return;
          params.push(value);
          updates.push(`${column} = $${params.length}${cast}`);
          changedFields[column] = value;
        };
        setOptional('title', input.title);
        setOptional('description', input.description);
        setOptional('responsible_party', input.responsibleParty);
        setOptional('due_date', input.dueDate, '::date');
        setOptional('obligation_type', input.obligationType, '::obligation_type');
        setOptional('sanction', input.sanction);
        setOptional('risk_level', input.riskLevel);
        if (Object.keys(changedFields).length) updates.push('version = version + 1');
        const updated = await client.query<{ id: string; verification_status: string; version: number }>(
          `
            UPDATE obligations
            SET ${updates.join(', ')}, updated_at = now()
            WHERE id = $1
            RETURNING id, verification_status, version
          `,
          params,
        );
        const historyValue = {
          changedFields,
          executionNotRequired: input.executionNotRequired === true,
          version: updated.rows[0]?.version ?? obligation.rows[0].version,
        };
        await client.query(
          `
            INSERT INTO obligation_verification_events (obligation_id, actor_user_id, action, new_value, comment)
            VALUES ($1, $2, $3, $4::jsonb, $5)
          `,
          [obligationId, userId, input.status, JSON.stringify(historyValue), comment],
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
        const actorRole = await client.query<{ is_lawyer: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1 FROM user_roles
              WHERE user_id = $1 AND role = 'lawyer'
            ) AS is_lawyer
          `,
          [userId],
        );
        if (input.status === 'corrected' && actorRole.rows[0]?.is_lawyer) {
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
              `Исправить замечание по обязательству «${input.title?.trim() || obligation.rows[0].title}»`,
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
          [userId, obligationId, JSON.stringify({ status: input.status, changedFields, executionNotRequired: input.executionNotRequired === true, commentTaskId })],
        );
        await client.query('COMMIT');
        return { obligationId, status: input.status, version: updated.rows[0]?.version, changedFields, commentTaskId };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
