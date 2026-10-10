import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from './infrastructure/database.js';
import { loadConfig } from './infrastructure/config.js';
import { createObjectStorage } from './infrastructure/object-storage.js';
import { createSessionStore } from './infrastructure/session-store.js';
import { createAuthService } from './modules/auth/auth-service.js';
import { createRegistryDomainModules } from './modules/registry/domain-modules.js';
import { createAuditService } from './modules/audit/audit-service.js';
import { createAuthMiddleware } from './http/auth-middleware.js';
import { handleAuthRoutes } from './http/auth-routes.js';
import { createApiController } from './http/api-controller.js';
import { redirect } from './http/http-utils.js';

const config = loadConfig();
const pool = createDatabasePool(config.databaseUrl);
const registry = createRegistryDomainModules(pool);
const storage = createObjectStorage(config);
const sessions = await createSessionStore(config.redisUrl);
const auth = createAuthService(pool, sessions, config);
const audit = createAuditService(pool);
const authMiddleware = createAuthMiddleware(auth);
const userIdFromRequest = (request: IncomingMessage) => authMiddleware.userId(request);
const indexHtml = fileURLToPath(new URL('./web/index.html', import.meta.url));
const loginHtml = fileURLToPath(new URL('./web/login.html', import.meta.url));
const providerHtml = fileURLToPath(new URL('./web/provider.html', import.meta.url));
const handleApi = createApiController({ pool, registry, storage, audit, userIdFromRequest });

const server = createServer(async (request, response) => {
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

  await handleApi(request, response, url);
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Monitoring API listening on http://127.0.0.1:${config.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await sessions.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
