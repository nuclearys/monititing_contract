import type { Pool } from 'pg';
import { visibilityCondition } from '../visibility.js';
import { filterConditions } from '../query-utils.js';
import type { RegistryFilters } from '../types.js';

export function createReadRepository(pool: Pool) {
  return {
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
