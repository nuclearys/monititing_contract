import type { Pool } from 'pg';

export type ApplicationRole =
  | 'lawyer'
  | 'deal_curator'
  | 'fco'
  | 'contract_manager'
  | 'observer'
  | 'administrator';

export async function hasAnyRole(pool: Pool, userId: string, roles: readonly ApplicationRole[]): Promise<boolean> {
  if (!roles.length) return false;
  const result = await pool.query(
    `
      SELECT 1
      FROM users AS u
      JOIN user_roles AS role ON role.user_id = u.id
      WHERE u.id = $1
        AND u.is_active = true
        AND role.role = ANY($2::user_role[])
      LIMIT 1
    `,
    [userId, roles],
  );
  return Boolean(result.rows[0]);
}

export async function requireRole(pool: Pool, userId: string, role: ApplicationRole): Promise<void> {
  if (!(await hasAnyRole(pool, userId, [role]))) {
    throw new Error('Недостаточно прав для выполнения операции.');
  }
}
