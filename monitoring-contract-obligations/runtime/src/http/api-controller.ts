import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { ObjectStorage } from '../infrastructure/object-storage.js';
import type { RegistryFilters } from '../modules/registry/types.js';
import type { createRegistryDomainModules } from '../modules/registry/domain-modules.js';
import { enqueueDocumentProcessing } from '../modules/processing/document-jobs.js';
import { jsonBody, multipartValue, parseMultipart, requestBuffer, sendJson } from './http-utils.js';

type Registry = ReturnType<typeof createRegistryDomainModules>;
type Audit = Readonly<{
  list(userId: string, filters: { entityType?: string; action?: string; page: number; pageSize: number }): Promise<unknown>;
}>;
type ApiControllerDependencies = Readonly<{
  pool: Pool;
  registry: Registry;
  storage: ObjectStorage;
  audit: Audit;
  userIdFromRequest(request: IncomingMessage): Promise<string | null>;
}>;

function integerParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function filtersFromUrl(url: URL): RegistryFilters {
  const sort = url.searchParams.get('sort');
  return {
    status: url.searchParams.get('status') ?? undefined,
    executionStatus: url.searchParams.get('execution_status') ?? undefined,
    verificationStatus: url.searchParams.get('verification_status') ?? undefined,
    obligationType: url.searchParams.get('obligation_type') ?? undefined,
    riskLevel: url.searchParams.get('risk') ?? undefined,
    responsibleParty: url.searchParams.get('party') ?? undefined,
    originContour: url.searchParams.get('contour') ?? undefined,
    dueFrom: url.searchParams.get('due_from') ?? undefined,
    dueTo: url.searchParams.get('due_to') ?? undefined,
    overdue: url.searchParams.has('overdue') ? url.searchParams.get('overdue') === 'true' : undefined,
    page: integerParam(url.searchParams.get('page'), 1, 1, 1_000_000),
    pageSize: integerParam(url.searchParams.get('page_size'), 10, 1, 100),
    sort: sort === 'updated_at' || sort === 'contract_number' || sort === 'risk_level' ? sort : 'due_date',
    direction: url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc',
  };
}

function isAllowed(value: string | null, allowed: readonly string[]): value is string {
  return value === null || allowed.includes(value);
}

export function createApiController(deps: ApiControllerDependencies) {
  return async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false;
    if (request.method === 'GET' && url.pathname === '/api/health') {
      try {
        await deps.pool.query('SELECT 1');
        sendJson(response, 200, { status: 'ok', database: 'ok' });
      } catch {
        sendJson(response, 503, { status: 'error', database: 'unavailable' });
      }
      return true;
    }
    const userId = await deps.userIdFromRequest(request);
    if (!userId) {
      sendJson(response, 401, { error: 'User context is required.' });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      const result = await deps.pool.query<{ id: string; full_name: string; email: string | null; roles: string[] }>(
        `
          SELECT u.id, u.full_name, u.email,
            COALESCE(array_agg(ur.role::text) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
          FROM users AS u
          LEFT JOIN user_roles AS ur ON ur.user_id = u.id
          WHERE u.id = $1 AND u.is_active = true
          GROUP BY u.id
        `,
        [userId],
      );
      if (!result.rows[0]) {
        sendJson(response, 401, { error: 'User is not active.' });
        return true;
      }
      sendJson(response, 200, result.rows[0]);
      return true;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/obligations') {
        sendJson(response, 200, await deps.registry.obligations.list(userId, filtersFromUrl(url)));
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        sendJson(response, 200, await deps.registry.dashboard(userId));
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/audit-events') {
        try {
          sendJson(response, 200, await deps.audit.list(userId, {
            entityType: url.searchParams.get('entity_type') ?? undefined,
            action: url.searchParams.get('action') ?? undefined,
            page: integerParam(url.searchParams.get('page'), 1, 1, 1_000_000),
            pageSize: integerParam(url.searchParams.get('page_size'), 25, 1, 100),
          }));
        } catch (error) {
          if (error instanceof Error && error.message.includes('Недостаточно прав')) {
            sendJson(response, 403, { error: error.message });
            return true;
          }
          throw error;
        }
        return true;
      }
      if (request.method === 'POST' && url.pathname === '/api/documents/upload') {
        const contentType = request.headers['content-type'] ?? '';
        const contentLength = Number(request.headers['content-length'] ?? 0);
        if (!contentType.startsWith('multipart/form-data') || contentLength > 25 * 1024 * 1024) {
          sendJson(response, 400, { error: 'Нужен multipart-файл размером не более 25 МБ.' });
          return true;
        }
        const parts = parseMultipart(await requestBuffer(request), contentType);
        const file = parts.find((item) => item.name === 'file' && Buffer.isBuffer(item.value));
        const fileName = file?.fileName?.trim() ?? '';
        const fileBuffer = Buffer.isBuffer(file?.value) ? file.value : null;
        const documentKind = multipartValue(parts, 'documentKind') || 'contract';
        const allowedDocumentKinds = new Set(['contract', 'annex', 'amendment', 'evidence', 'other']);
        const contractNumber = multipartValue(parts, 'contractNumber');
        const title = multipartValue(parts, 'title');
        const counterpartyName = multipartValue(parts, 'counterpartyName');
        const contractDate = multipartValue(parts, 'contractDate') || null;
        if (!fileBuffer || !fileName || !contractNumber || !title || !counterpartyName || !allowedDocumentKinds.has(documentKind)) {
          sendJson(response, 400, { error: 'Заполните реквизиты договора и выберите файл.' });
          return true;
        }
        const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
        const storageKey = `${randomUUID()}${extension}`;
        try {
          await deps.storage.put(storageKey, fileBuffer, file?.mimeType || 'application/octet-stream');
          const created = await deps.registry.contracts.uploadManualDocument(userId, {
            contractNumber,
            title,
            counterpartyName,
            contractDate,
            documentKind: documentKind as 'contract' | 'annex' | 'amendment' | 'evidence' | 'other',
            fileName,
            storageKey,
            mimeType: file?.mimeType || 'application/octet-stream',
            sha256: createHash('sha256').update(fileBuffer).digest('hex'),
            fileSize: fileBuffer.length,
          });
          if (!created) {
            await deps.storage.remove(storageKey).catch(() => undefined);
            sendJson(response, 403, { error: 'Ручная загрузка доступна контрактному менеджеру или администратору.' });
            return true;
          }
          await enqueueDocumentProcessing(deps.pool, created.documentId);
          sendJson(response, 201, created);
        } catch (error) {
          await deps.storage.remove(storageKey).catch(() => undefined);
          throw error;
        }
        return true;
      }

      const executionMatch = url.pathname.match(/^\/api\/obligations\/([^/]+)\/execution$/);
      if (request.method === 'PATCH' && executionMatch) {
        const body = await jsonBody(request);
        const status = body.status;
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        const actualExecutionDate = typeof body.actualExecutionDate === 'string' ? body.actualExecutionDate : null;
        const overdueReason = typeof body.overdueReason === 'string' ? body.overdueReason.trim() : null;
        const overdueComment = typeof body.overdueComment === 'string' ? body.overdueComment.trim() : null;
        const evidenceDocumentId = typeof body.evidenceDocumentId === 'string' && body.evidenceDocumentId.trim() ? body.evidenceDocumentId.trim() : null;
        const allowedStatuses = ['not_started', 'in_progress', 'completed', 'overdue', 'not_applicable'] as const;
        if (typeof status !== 'string' || !allowedStatuses.includes(status as typeof allowedStatuses[number])) {
          sendJson(response, 400, { error: 'Недопустимый статус исполнения.' });
          return true;
        }
        if (!comment) {
          sendJson(response, 400, { error: 'Комментарий обязателен.' });
          return true;
        }
        if (status === 'completed' && (!actualExecutionDate || !evidenceDocumentId)) {
          sendJson(response, 400, { error: 'Для статуса «Исполнено» нужны дата и подтверждающий документ.' });
          return true;
        }
        if (status === 'overdue' && (!overdueReason || !overdueComment)) {
          sendJson(response, 400, { error: 'Для статуса «Просрочено» нужны комментарий и причина просрочки.' });
          return true;
        }
        const updated = await deps.registry.obligations.updateExecution(userId, executionMatch[1], {
          status: status as 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'not_applicable',
          comment,
          actualExecutionDate,
          overdueReason,
          overdueComment,
          evidenceDocumentId,
        });
        if (!updated) {
          sendJson(response, 403, { error: 'Обязательство недоступно для изменения текущему пользователю.' });
          return true;
        }
        sendJson(response, 200, updated);
        return true;
      }

      const commentsMatch = url.pathname.match(/^\/api\/obligations\/([^/]+)\/comments$/);
      if (commentsMatch && request.method === 'GET') {
        sendJson(response, 200, await deps.registry.comments.list(userId, commentsMatch[1]));
        return true;
      }
      if (commentsMatch && request.method === 'POST') {
        const body = await jsonBody(request);
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        const sourceLocator = body.sourceLocator && typeof body.sourceLocator === 'object' && !Array.isArray(body.sourceLocator)
          ? body.sourceLocator as Record<string, unknown>
          : null;
        if (!comment) {
          sendJson(response, 400, { error: 'Введите замечание.' });
          return true;
        }
        const created = await deps.registry.comments.add(userId, commentsMatch[1], { comment, sourceLocator });
        if (!created) {
          sendJson(response, 403, { error: 'Обязательство недоступно текущему пользователю.' });
          return true;
        }
        sendJson(response, 201, created);
        return true;
      }

      const verificationMatch = url.pathname.match(/^\/api\/obligations\/([^/]+)\/verification$/);
      if (request.method === 'PATCH' && verificationMatch) {
        const body = await jsonBody(request);
        const status = body.status;
        const comment = typeof body.comment === 'string' ? body.comment.trim() : null;
        if (status !== 'confirmed' && status !== 'corrected') {
          sendJson(response, 400, { error: 'Недопустимый результат проверки обязательства.' });
          return true;
        }
        if (status === 'corrected' && !comment) {
          sendJson(response, 400, { error: 'Для замечания юриста нужен комментарий.' });
          return true;
        }
        const updated = await deps.registry.obligations.updateVerification(userId, verificationMatch[1], {
          status,
          comment,
          executionNotRequired: body.executionNotRequired === true,
        });
        if (!updated) {
          sendJson(response, 403, { error: 'Обязательство недоступно юристу для проверки.' });
          return true;
        }
        sendJson(response, 200, updated);
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/review-task-groups') {
        const status = url.searchParams.get('status');
        const dueScope = url.searchParams.get('due_scope');
        if (!isAllowed(status, ['open', 'in_progress', 'completed', 'needs_revision']) || !isAllowed(dueScope, ['today', 'upcoming', 'no_due'])) {
          sendJson(response, 400, { error: 'Недопустимый фильтр задачи.' });
          return true;
        }
        sendJson(response, 200, await deps.registry.tasks.groups(userId, status ?? undefined, dueScope ?? undefined));
        return true;
      }
      const taskGroupMatch = url.pathname.match(/^\/api\/review-task-groups\/([^/]+)$/);
      if (request.method === 'GET' && taskGroupMatch) {
        sendJson(response, 200, await deps.registry.tasks.group(userId, taskGroupMatch[1]));
        return true;
      }
      if (request.method === 'GET' && url.pathname === '/api/review-tasks') {
        const status = url.searchParams.get('status');
        const taskType = url.searchParams.get('task_type');
        const dueScope = url.searchParams.get('due_scope');
        if (!isAllowed(status, ['open', 'in_progress', 'completed', 'declined']) || !isAllowed(taskType, ['comment_response', 'verification']) || !isAllowed(dueScope, ['today', 'upcoming', 'no_due'])) {
          sendJson(response, 400, { error: 'Недопустимый фильтр задачи.' });
          return true;
        }
        sendJson(response, 200, await deps.registry.tasks.list(userId, status ?? undefined, taskType ?? undefined, dueScope ?? undefined));
        return true;
      }
      const reviewTaskMatch = url.pathname.match(/^\/api\/review-tasks\/([^/]+)$/);
      if (request.method === 'PATCH' && reviewTaskMatch) {
        const body = await jsonBody(request);
        const status = body.status;
        const responseComment = typeof body.responseComment === 'string' ? body.responseComment.trim() : '';
        const allowedStatuses = ['open', 'in_progress', 'completed', 'declined'] as const;
        if (typeof status !== 'string' || !allowedStatuses.includes(status as typeof allowedStatuses[number])) {
          sendJson(response, 400, { error: 'Недопустимый статус задачи.' });
          return true;
        }
        if ((status === 'completed' || status === 'declined') && !responseComment) {
          sendJson(response, 400, { error: 'Для завершения или отклонения нужен комментарий куратора.' });
          return true;
        }
        const updated = await deps.registry.tasks.update(userId, reviewTaskMatch[1], {
          status: status as 'open' | 'in_progress' | 'completed' | 'declined',
          responseComment: responseComment || null,
        });
        if (!updated) {
          sendJson(response, 403, { error: 'Задача недоступна текущему пользователю.' });
          return true;
        }
        sendJson(response, 200, updated);
        return true;
      }

      const contractMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)$/);
      if (request.method === 'GET' && contractMatch) {
        const card = await deps.registry.contracts.contractCard(userId, contractMatch[1]);
        if (!card) {
          sendJson(response, 404, { error: 'Contract not found.' });
          return true;
        }
        sendJson(response, 200, card);
        return true;
      }
      const processDocumentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/process$/);
      if (request.method === 'POST' && processDocumentMatch) {
        if (!(await deps.registry.contracts.documentText(userId, processDocumentMatch[1]))) {
          sendJson(response, 404, { error: 'Document not found.' });
          return true;
        }
        await enqueueDocumentProcessing(deps.pool, processDocumentMatch[1]);
        sendJson(response, 202, { status: 'processing' });
        return true;
      }
      const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/text$/);
      if (request.method === 'GET' && documentMatch) {
        const document = await deps.registry.contracts.documentText(userId, documentMatch[1]);
        if (!document) {
          sendJson(response, 404, { error: 'Document not found.' });
          return true;
        }
        sendJson(response, 200, document);
        return true;
      }
      sendJson(response, 404, { error: 'Route not found.' });
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { error: 'Internal server error.' });
    }
    return true;
  };
}
