import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from './infrastructure/database.js';
import { createRegistryRepository, type RegistryFilters } from './modules/registry/registry.js';
import { createDocumentProcessor } from './modules/processing/document-processor.js';

const port = Number(process.env.PORT ?? 4174);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL in runtime/.env.');

const pool = createDatabasePool(databaseUrl);
const registry = createRegistryRepository(pool);
const indexHtml = fileURLToPath(new URL('./web/index.html', import.meta.url));
const loginHtml = fileURLToPath(new URL('./web/login.html', import.meta.url));
const providerHtml = fileURLToPath(new URL('./web/provider.html', import.meta.url));
const storageDirectory = fileURLToPath(new URL('../storage/', import.meta.url));
const sessions = new Map<string, { userId: string; createdAt: number }>();
const documentProcessor = createDocumentProcessor(registry, storageDirectory);

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function userIdFromRequest(request: IncomingMessage): string | null {
  const cookie = request.headers.cookie?.match(/(?:^|;\s*)monitoring_session=([^;]+)/)?.[1];
  if (cookie) return sessions.get(cookie)?.userId ?? null;
  const devUserId = request.headers['x-dev-user-id'];
  if (process.env.NODE_ENV !== 'production' && typeof devUserId === 'string') return devUserId;
  return null;
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  response.writeHead(302, { location, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  response.end();
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function requestBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type MultipartPart = Readonly<{ name: string; fileName?: string; mimeType?: string; value: string | Buffer }>;

function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) return [];
  const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(boundary);
  while (cursor >= 0) {
    const partStart = cursor + boundary.length;
    if (body.subarray(partStart, partStart + 2).toString() === '--') break;
    const contentStart = partStart + 2;
    const nextBoundary = body.indexOf(boundary, contentStart);
    if (nextBoundary < 0) break;
    const part = body.subarray(contentStart, Math.max(contentStart, nextBoundary - 2));
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
      if (disposition) {
        const mime = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
        const data = part.subarray(headerEnd + 4);
        parts.push({
          name: disposition[1],
          fileName: disposition[2] || undefined,
          mimeType: mime,
          value: disposition[2] ? data : data.toString('utf8'),
        });
      }
    }
    cursor = nextBoundary;
  }
  return parts;
}

function multipartValue(parts: MultipartPart[], name: string): string {
  const part = parts.find((item) => item.name === name && typeof item.value === 'string');
  return typeof part?.value === 'string' ? part.value.trim() : '';
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await requestBody(request);
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function createLocalUser(login: string, role: string): Promise<string> {
  const allowedRoles = new Set(['lawyer', 'deal_curator', 'fco', 'contract_manager', 'observer', 'administrator']);
  const safeRole = allowedRoles.has(role) ? role : 'lawyer';
  const normalizedLogin = login.trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ id: string }>(
      `
        INSERT INTO users (external_subject, full_name, email)
        VALUES ($1, $2, $3)
        ON CONFLICT (external_subject)
        DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email, is_active = true
        RETURNING id
      `,
      [`dev:${normalizedLogin}`, normalizedLogin, `${normalizedLogin}@example.local`],
    );
    const userId = user.rows[0].id;
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    await client.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, $2::user_role)
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId, safeRole],
    );
    await client.query(
      `
        INSERT INTO user_access_scopes (user_id, scope_type)
        SELECT $1, 'full_perimeter'::access_scope_type
        WHERE NOT EXISTS (
          SELECT 1 FROM user_access_scopes
          WHERE user_id = $1 AND scope_type = 'full_perimeter'
        )
      `,
      [userId],
    );
    await client.query('COMMIT');
    return userId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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

  if (request.method === 'GET' && url.pathname === '/login') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(loginHtml));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/auth/provider') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(providerHtml));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/auth/provider') {
    const form = new URLSearchParams(await requestBody(request));
    const login = form.get('login')?.trim();
    if (!login || !form.get('password')) {
      sendJson(response, 400, { error: 'Login and password are required.' });
      return;
    }
    const userId = await createLocalUser(login, form.get('role') ?? 'lawyer');
    const sessionId = randomUUID();
    sessions.set(sessionId, { userId, createdAt: Date.now() });
    redirect(response, '/', [`monitoring_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`]);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/logout') {
    const session = request.headers.cookie?.match(/(?:^|;\s*)monitoring_session=([^;]+)/)?.[1];
    if (session) sessions.delete(session);
    redirect(response, '/login', ['monitoring_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/']);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/') {
    if (!userIdFromRequest(request)) {
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
    const currentUserId = userIdFromRequest(request);
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

  const userId = userIdFromRequest(request);
  if (!userId) {
    sendJson(response, 401, { error: 'User context is required.' });
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/api/obligations') {
      sendJson(response, 200, await registry.list(userId, filtersFromUrl(url)));
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
      await mkdir(storageDirectory, { recursive: true });
      const storagePath = `${storageDirectory}/${storageKey}`;
      await writeFile(storagePath, fileBuffer);
      try {
        const created = await registry.uploadManualDocument(userId, {
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
          await unlink(storagePath).catch(() => undefined);
          sendJson(response, 403, { error: 'Ручная загрузка доступна контрактному менеджеру или администратору.' });
          return;
        }
        void documentProcessor.process(created.documentId);
        sendJson(response, 201, created);
      } catch (error) {
        await unlink(storagePath).catch(() => undefined);
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
      const updated = await registry.updateExecution(userId, executionMatch[1], {
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
      sendJson(response, 200, await registry.obligationComments(userId, commentsMatch[1]));
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
      const created = await registry.addObligationComment(userId, commentsMatch[1], { comment, sourceLocator });
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
      const updated = await registry.updateObligationVerification(userId, verificationMatch[1], {
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
      sendJson(response, 200, await registry.reviewTaskGroups(userId, status, dueScope));
      return;
    }

    const taskGroupMatch = url.pathname.match(/^\/api\/review-task-groups\/([^/]+)$/);
    if (request.method === 'GET' && taskGroupMatch) {
      sendJson(response, 200, await registry.reviewTaskGroup(userId, taskGroupMatch[1]));
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
      sendJson(response, 200, await registry.reviewTasks(userId, status, taskType, dueScope));
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
      const updated = await registry.updateReviewTask(userId, reviewTaskMatch[1], {
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
      const card = await registry.contractCard(userId, contractMatch[1]);
      if (!card) {
        sendJson(response, 404, { error: 'Contract not found.' });
        return;
      }
      sendJson(response, 200, card);
      return;
    }

    const processDocumentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/process$/);
    if (request.method === 'POST' && processDocumentMatch) {
      const visibleDocument = await registry.documentText(userId, processDocumentMatch[1]);
      if (!visibleDocument) {
        sendJson(response, 404, { error: 'Document not found.' });
        return;
      }
      void documentProcessor.process(processDocumentMatch[1]);
      sendJson(response, 202, { status: 'processing' });
      return;
    }

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/text$/);
    if (request.method === 'GET' && documentMatch) {
      const document = await registry.documentText(userId, documentMatch[1]);
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
  await pool.end();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
