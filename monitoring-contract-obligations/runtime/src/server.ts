import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from './infrastructure/database.js';
import { loadConfig } from './infrastructure/config.js';
import { createObjectStorage } from './infrastructure/object-storage.js';
import { createSessionStore } from './infrastructure/session-store.js';
import { createAuthService } from './modules/auth/auth-service.js';
import type { RegistryFilters } from './modules/registry/registry.js';
import { createRegistryDomainModules } from './modules/registry/domain-modules.js';
import { enqueueDocumentProcessing } from './modules/processing/document-jobs.js';
import { jsonBody, multipartValue, parseMultipart, redirect, requestBuffer, sendJson } from './http/http-utils.js';
import { createAuthMiddleware } from './http/auth-middleware.js';
import { handleAuthRoutes } from './http/auth-routes.js';

const config = loadConfig();
const port = config.port;
const pool = createDatabasePool(config.databaseUrl);
const registry = createRegistryDomainModules(pool);
const indexHtml = fileURLToPath(new URL('./web/index.html', import.meta.url));
const loginHtml = fileURLToPath(new URL('./web/login.html', import.meta.url));
const providerHtml = fileURLToPath(new URL('./web/provider.html', import.meta.url));
const storage = createObjectStorage(config);
const sessions = await createSessionStore(config.redisUrl);
const auth = createAuthService(pool, sessions, config);
const authMiddleware = createAuthMiddleware(auth);
const userIdFromRequest = (request: IncomingMessage): Promise<string | null> => authMiddleware.userId(request);

function integerParam(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value ? Number(value) : fallback;
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function filtersFromUrl(url: URL): RegistryFilters {
  const sort = url.searchParams.get('sort');
  const direction = url.searchParams.get('direction');
  const overdue = url.searchParams.get('overdue');
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
    overdue: overdue === null ? undefined : overdue === 'true',
    page: integerParam(url.searchParams.get('page'), 1, 1, 1_000_000),
    pageSize: integerParam(url.searchParams.get('page_size'), 10, 1, 100),
    sort: sort === 'updated_at' || sort === 'contract_number' || sort === 'risk_level'
      ? sort
      : 'due_date',
    direction: direction === 'desc' ? 'desc' : 'asc',
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (await handleAuthRoutes(request, response, url, {
    authMode: config.authMode,
    auth,
    sessions,
    sessionTtlSeconds: config.sessionTtlSeconds,
    loginHtml,
    providerHtml,
  })) return;

  if (request.method === 'GET' && url.pathname === '/') {
    if (!(await userIdFromRequest(request))) {
      redirect(response, '/login');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(indexHtml));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    try {
      await pool.query('SELECT 1');
      sendJson(response, 200, { status: 'ok', database: 'ok' });
    } catch {
      sendJson(response, 503, { status: 'error', database: 'unavailable' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/me') {
    const currentUserId = await userIdFromRequest(request);
    if (!currentUserId) {
      sendJson(response, 401, { error: 'User context is required.' });
      return;
    }
    const result = await pool.query<{ id: string; full_name: string; email: string | null; roles: string[] }>(
      `
        SELECT u.id, u.full_name, u.email,
          COALESCE(array_agg(ur.role::text) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
        FROM users AS u
        LEFT JOIN user_roles AS ur ON ur.user_id = u.id
        WHERE u.id = $1 AND u.is_active = true
        GROUP BY u.id
      `,
      [currentUserId],
    );
    if (!result.rows[0]) {
      sendJson(response, 401, { error: 'User is not active.' });
      return;
    }
    sendJson(response, 200, result.rows[0]);
    return;
  }

  const userId = await userIdFromRequest(request);
  if (!userId) {
    sendJson(response, 401, { error: 'User context is required.' });
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/obligations') {
      sendJson(response, 200, await registry.obligations.list(userId, filtersFromUrl(url)));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/dashboard') {
      sendJson(response, 200, await registry.dashboard(userId));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/documents/upload') {
      const contentType = request.headers['content-type'] ?? '';
      const contentLength = Number(request.headers['content-length'] ?? 0);
      if (!contentType.startsWith('multipart/form-data') || contentLength > 25 * 1024 * 1024) {
        sendJson(response, 400, { error: 'Нужен multipart-файл размером не более 25 МБ.' });
        return;
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
        return;
      }
      const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
      const storageKey = `${randomUUID()}${extension}`;
      try {
        await storage.put(storageKey, fileBuffer, file?.mimeType || 'application/octet-stream');
        const created = await registry.contracts.uploadManualDocument(userId, {
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
          await storage.remove(storageKey).catch(() => undefined);
          sendJson(response, 403, { error: 'Ручная загрузка доступна контрактному менеджеру или администратору.' });
          return;
        }
        await enqueueDocumentProcessing(pool, created.documentId);
        sendJson(response, 201, created);
      } catch (error) {
        await storage.remove(storageKey).catch(() => undefined);
        throw error;
      }
      return;
    }

    const executionMatch = url.pathname.match(/^\/api\/obligations\/([^/]+)\/execution$/);
    if (request.method === 'PATCH' && executionMatch) {
      const body = await jsonBody(request);
      const status = body.status;
      const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
      const actualExecutionDate = typeof body.actualExecutionDate === 'string' ? body.actualExecutionDate : null;
      const overdueReason = typeof body.overdueReason === 'string' ? body.overdueReason.trim() : null;
      const overdueComment = typeof body.overdueComment === 'string' ? body.overdueComment.trim() : null;
      const evidenceDocumentId = typeof body.evidenceDocumentId === 'string' && body.evidenceDocumentId.trim()
        ? body.evidenceDocumentId.trim()
        : null;
      const allowedStatuses = new Set(['not_started', 'in_progress', 'completed', 'overdue', 'not_applicable']);
      if (typeof status !== 'string' || !allowedStatuses.has(status)) {
        sendJson(response, 400, { error: 'Недопустимый статус исполнения.' });
        return;
      }
      if (!comment) {
        sendJson(response, 400, { error: 'Комментарий обязателен.' });
        return;
      }
      if (status === 'completed' && (!actualExecutionDate || !evidenceDocumentId)) {
        sendJson(response, 400, { error: 'Для статуса «Исполнено» нужны дата и подтверждающий документ.' });
        return;
      }
      if (status === 'overdue' && (!overdueReason || !overdueComment)) {
        sendJson(response, 400, { error: 'Для статуса «Просрочено» нужны комментарий и причина просрочки.' });
        return;
      }
      const updated = await registry.obligations.updateExecution(userId, executionMatch[1], {
        status: status as 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'not_applicable',
        comment,
        actualExecutionDate,
        overdueReason,
        overdueComment,
        evidenceDocumentId,
      });
      if (!updated) {
        sendJson(response, 403, { error: 'Обязательство недоступно для изменения текущему пользователю.' });
        return;
      }
      sendJson(response, 200, updated);
      return;
    }

    const commentsMatch = url.pathname.match(/^\/api\/obligations\/([^/]+)\/comments$/);
    if (commentsMatch && request.method === 'GET') {
      sendJson(response, 200, await registry.comments.list(userId, commentsMatch[1]));
      return;
    }
    if (commentsMatch && request.method === 'POST') {
      const body = await jsonBody(request);
      const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
      const sourceLocator = body.sourceLocator && typeof body.sourceLocator === 'object' && !Array.isArray(body.sourceLocator)
        ? body.sourceLocator as Record<string, unknown>
        : null;
      if (!comment) {
        sendJson(response, 400, { error: 'Введите замечание.' });
        return;
      }
      const created = await registry.comments.add(userId, commentsMatch[1], { comment, sourceLocator });
      if (!created) {
        sendJson(response, 403, { error: 'Обязательство недоступно текущему пользователю.' });
        return;
      }
      sendJson(response, 201, created);
      return;
    }

    const verificationMatch = url.pathname.match(/^\/api\/obligations\/([^/]+)\/verification$/);
    if (request.method === 'PATCH' && verificationMatch) {
      const body = await jsonBody(request);
      const status = body.status;
      const comment = typeof body.comment === 'string' ? body.comment.trim() : null;
      const executionNotRequired = body.executionNotRequired === true;
      if (status !== 'confirmed' && status !== 'corrected') {
        sendJson(response, 400, { error: 'Недопустимый результат проверки обязательства.' });
        return;
      }
      if (status === 'corrected' && !comment) {
        sendJson(response, 400, { error: 'Для замечания юриста нужен комментарий.' });
        return;
      }
      const updated = await registry.obligations.updateVerification(userId, verificationMatch[1], {
        status,
        comment,
        executionNotRequired,
      });
      if (!updated) {
        sendJson(response, 403, { error: 'Обязательство недоступно юристу для проверки.' });
        return;
      }
      sendJson(response, 200, updated);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/review-task-groups') {
      const status = url.searchParams.get('status') ?? undefined;
      const dueScope = url.searchParams.get('due_scope') ?? undefined;
      const allowedStatuses = new Set(['open', 'in_progress', 'completed', 'needs_revision']);
      const allowedDueScopes = new Set(['today', 'upcoming', 'no_due']);
      if (status && !allowedStatuses.has(status)) {
        sendJson(response, 400, { error: 'Недопустимый статус задачи.' });
        return;
      }
      if (dueScope && !allowedDueScopes.has(dueScope)) {
        sendJson(response, 400, { error: 'Недопустимый фильтр срока задачи.' });
        return;
      }
      sendJson(response, 200, await registry.tasks.groups(userId, status, dueScope));
      return;
    }

    const taskGroupMatch = url.pathname.match(/^\/api\/review-task-groups\/([^/]+)$/);
    if (request.method === 'GET' && taskGroupMatch) {
      sendJson(response, 200, await registry.tasks.group(userId, taskGroupMatch[1]));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/review-tasks') {
      const status = url.searchParams.get('status') ?? undefined;
      const taskType = url.searchParams.get('task_type') ?? undefined;
      const dueScope = url.searchParams.get('due_scope') ?? undefined;
      const allowedStatuses = new Set(['open', 'in_progress', 'completed', 'declined']);
      const allowedTaskTypes = new Set(['comment_response', 'verification']);
      const allowedDueScopes = new Set(['today', 'upcoming', 'no_due']);
      if (status && !allowedStatuses.has(status)) {
        sendJson(response, 400, { error: 'Недопустимый статус задачи.' });
        return;
      }
      if (taskType && !allowedTaskTypes.has(taskType)) {
        sendJson(response, 400, { error: 'Недопустимый тип задачи.' });
        return;
      }
      if (dueScope && !allowedDueScopes.has(dueScope)) {
        sendJson(response, 400, { error: 'Недопустимый фильтр срока задачи.' });
        return;
      }
      sendJson(response, 200, await registry.tasks.list(userId, status, taskType, dueScope));
      return;
    }

    const reviewTaskMatch = url.pathname.match(/^\/api\/review-tasks\/([^/]+)$/);
    if (request.method === 'PATCH' && reviewTaskMatch) {
      const body = await jsonBody(request);
      const status = body.status;
      const responseComment = typeof body.responseComment === 'string' ? body.responseComment.trim() : '';
      const allowedStatuses = new Set(['open', 'in_progress', 'completed', 'declined']);
      if (typeof status !== 'string' || !allowedStatuses.has(status)) {
        sendJson(response, 400, { error: 'Недопустимый статус задачи.' });
        return;
      }
      if ((status === 'completed' || status === 'declined') && !responseComment) {
        sendJson(response, 400, { error: 'Для завершения или отклонения нужен комментарий куратора.' });
        return;
      }
      const updated = await registry.tasks.update(userId, reviewTaskMatch[1], {
        status: status as 'open' | 'in_progress' | 'completed' | 'declined',
        responseComment: responseComment || null,
      });
      if (!updated) {
        sendJson(response, 403, { error: 'Задача недоступна текущему пользователю.' });
        return;
      }
      sendJson(response, 200, updated);
      return;
    }

    const contractMatch = url.pathname.match(/^\/api\/contracts\/([^/]+)$/);
    if (request.method === 'GET' && contractMatch) {
      const card = await registry.contracts.contractCard(userId, contractMatch[1]);
      if (!card) {
        sendJson(response, 404, { error: 'Contract not found.' });
        return;
      }
      sendJson(response, 200, card);
      return;
    }

    const processDocumentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/process$/);
    if (request.method === 'POST' && processDocumentMatch) {
      const visibleDocument = await registry.contracts.documentText(userId, processDocumentMatch[1]);
      if (!visibleDocument) {
        sendJson(response, 404, { error: 'Document not found.' });
        return;
      }
      await enqueueDocumentProcessing(pool, processDocumentMatch[1]);
      sendJson(response, 202, { status: 'processing' });
      return;
    }

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/text$/);
    if (request.method === 'GET' && documentMatch) {
      const document = await registry.contracts.documentText(userId, documentMatch[1]);
      if (!document) {
        sendJson(response, 404, { error: 'Document not found.' });
        return;
      }
      sendJson(response, 200, document);
      return;
    }

    sendJson(response, 404, { error: 'Route not found.' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Internal server error.' });
  }
}

const server = createServer((request, response) => {
  void handle(request, response);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Monitoring API listening on http://127.0.0.1:${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await sessions.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
