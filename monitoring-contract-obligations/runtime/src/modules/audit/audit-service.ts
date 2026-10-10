import type { Pool } from 'pg';
import { requireRole } from '../auth/access-control.js';

export type AuditFilters = Readonly<{
  entityType?: string;
  action?: string;
  page: number;
  pageSize: number;
}>;

export function createAuditService(pool: Pool) {
  return {
    async list(userId: string, filters: AuditFilters) {
      await requireRole(pool, userId, 'administrator');
      const values: unknown[] = [];
      const conditions: string[] = [];
      if (filters.entityType) {
        values.push(filters.entityType);
        conditions.push(`event.entity_type = $${values.length}`);
      }
      if (filters.action) {
        values.push(filters.action);
        conditions.push(`event.action = $${values.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const countResult = await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM audit_events AS event ${where}`,
        values,
      );
      const offset = (filters.page - 1) * filters.pageSize;
      const rows = await pool.query(
        `
          SELECT
            event.id,
            event.entity_type,
            event.entity_id,
            event.action,
            event.payload,
            event.created_at,
            actor.id AS actor_user_id,
            actor.full_name AS actor_name,
            actor.email AS actor_email
          FROM audit_events AS event
          LEFT JOIN users AS actor ON actor.id = event.actor_user_id
          ${where}
          ORDER BY event.created_at DESC
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
  };
}
