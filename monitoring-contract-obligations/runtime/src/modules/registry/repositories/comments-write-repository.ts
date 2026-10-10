import type { Pool } from 'pg';
import { visibilityCondition } from '../visibility.js';
import type { ObligationCommentInput } from '../types.js';

export function createCommentsWriteRepository(pool: Pool) {
  return {
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
  };
}

