import type { Pool } from 'pg';
import { visibilityCondition } from './visibility.js';
import { createReadRepository } from './repositories/read-repository.js';
import { createContractWriteRepository } from './repositories/contracts-write-repository.js';
import { createObligationWriteRepository } from './repositories/obligations-write-repository.js';
import { createCommentsWriteRepository } from './repositories/comments-write-repository.js';
import { createTasksWriteRepository } from './repositories/tasks-write-repository.js';

export function createRegistryRepository(pool: Pool) {
  const readRepository = createReadRepository(pool);
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

    ...createContractWriteRepository(pool),
    ...createObligationWriteRepository(pool),
    ...createCommentsWriteRepository(pool),
    ...createTasksWriteRepository(pool),
    list: readRepository.list,
    contractCard: readRepository.contractCard,
    documentText: readRepository.documentText,
  };
}

export type { RegistryFilters } from './types.js';
