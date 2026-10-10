export const visibilityCondition = `(
  EXISTS (
    SELECT 1 FROM user_roles AS admin_role
    WHERE admin_role.user_id = $1 AND admin_role.role = 'administrator'
  )
  OR EXISTS (
    SELECT 1 FROM user_access_scopes AS full_scope
    WHERE full_scope.user_id = $1 AND full_scope.scope_type = 'full_perimeter'
  )
  OR (
    EXISTS (
      SELECT 1 FROM user_roles AS curator_role
      WHERE curator_role.user_id = $1 AND curator_role.role = 'deal_curator'
    )
    AND c.curator_user_id = $1
  )
  OR EXISTS (
    SELECT 1 FROM user_access_scopes AS scoped_access
    WHERE scoped_access.user_id = $1
      AND (
        (scoped_access.scope_type = 'business_unit' AND c.business_unit_id = scoped_access.organizational_unit_id)
        OR (scoped_access.scope_type = 'legal_service' AND c.legal_service_id = scoped_access.organizational_unit_id)
        OR (scoped_access.scope_type = 'fco' AND c.fco_id = scoped_access.organizational_unit_id)
        OR (scoped_access.scope_type = 'branch' AND c.branch_id = scoped_access.organizational_unit_id)
      )
  )
)`;

export const reviewTaskVisibilityCondition = visibilityCondition.replaceAll('c.', 'contract.');
