import type { RegistryFilters } from './types.js';

function addFilter(values: unknown[], expression: string, value: unknown): string {
  values.push(value);
  return `${expression} $${values.length}`;
}

export function filterConditions(values: unknown[], filters: RegistryFilters): string[] {
  const conditions: string[] = [];
  if (filters.status) conditions.push(addFilter(values, 'r.obligation_status =', filters.status));
  if (filters.executionStatus) conditions.push(addFilter(values, 'r.execution_status =', filters.executionStatus));
  if (filters.verificationStatus) conditions.push(addFilter(values, 'r.verification_status =', filters.verificationStatus));
  if (filters.obligationType) conditions.push(addFilter(values, 'r.obligation_type =', filters.obligationType));
  if (filters.riskLevel) conditions.push(addFilter(values, 'r.risk_level =', filters.riskLevel));
  if (filters.responsibleParty) conditions.push(addFilter(values, 'r.responsible_party =', filters.responsibleParty));
  if (filters.originContour) conditions.push(addFilter(values, 'r.origin_contour =', filters.originContour));
  if (filters.dueFrom) conditions.push(addFilter(values, 'r.due_date >=', filters.dueFrom));
  if (filters.dueTo) conditions.push(addFilter(values, 'r.due_date <=', filters.dueTo));
  if (filters.overdue !== undefined) conditions.push(addFilter(values, 'r.is_overdue =', filters.overdue));
  return conditions;
}
