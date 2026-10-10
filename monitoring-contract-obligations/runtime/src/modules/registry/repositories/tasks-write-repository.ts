import type { Pool } from 'pg';
import { reviewTaskVisibilityCondition } from '../visibility.js';
import type { ReviewTaskUpdateInput } from '../types.js';

export function createTasksWriteRepository(pool: Pool) {
  return {
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
  };
}
