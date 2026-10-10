export type RegistryFilters = Readonly<{
  status?: string;
  executionStatus?: string;
  verificationStatus?: string;
  obligationType?: string;
  riskLevel?: string;
  responsibleParty?: string;
  originContour?: string;
  dueFrom?: string;
  dueTo?: string;
  overdue?: boolean;
  page: number;
  pageSize: number;
  sort: 'due_date' | 'updated_at' | 'contract_number' | 'risk_level';
  direction: 'asc' | 'desc';
}>;

export type ExecutionUpdateInput = Readonly<{
  status: 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'not_applicable';
  comment: string;
  actualExecutionDate?: string | null;
  overdueReason?: string | null;
  overdueComment?: string | null;
  evidenceDocumentId?: string | null;
}>;

export type ManualDocumentInput = Readonly<{
  contractNumber: string;
  title: string;
  counterpartyName: string;
  contractDate?: string | null;
  documentKind: 'contract' | 'annex' | 'amendment' | 'evidence' | 'other';
  fileName: string;
  storageKey: string;
  mimeType: string;
  sha256: string;
  fileSize: number;
}>;

export type ObligationCommentInput = Readonly<{
  comment: string;
  sourceLocator?: Record<string, unknown> | null;
}>;

export type ReviewTaskUpdateInput = Readonly<{
  status: 'open' | 'in_progress' | 'completed' | 'declined';
  responseComment?: string | null;
  sendForRecheck?: boolean;
}>;

export type VerificationUpdateInput = Readonly<{
  status: 'confirmed' | 'corrected';
  comment?: string | null;
  executionNotRequired?: boolean;
}>;
