import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthMode } from '../infrastructure/config.js';
import type { SessionStore } from '../infrastructure/session-store.js';
import { redirect, requestBody, sendJson } from './http-utils.js';

type AuthRouteService = Readonly<{
  createLocalUser(login: string, role: string): Promise<string>;
  beginOidcLogin(): Promise<string>;
  completeOidcLogin(url: URL): Promise<{ sessionId: string }>;
}>;

export async function handleAuthRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  input: Readonly<{
    authMode: AuthMode;
    auth: AuthRouteService;
    sessions: SessionStore;
    sessionTtlSeconds: number;
    loginHtml: string;
    providerHtml: string;
  }>,
): Promise<boolean> {
  if (request.method === 'GET' && url.pathname === '/login') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(input.loginHtml));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/auth/provider') {
    if (input.authMode === 'oidc') {
      redirect(response, await input.auth.beginOidcLogin());
      return true;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(await readFile(input.providerHtml));
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/auth/callback') {
    try {
      const result = await input.auth.completeOidcLogin(url);
      redirect(response, '/', [`monitoring_session=${result.sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OIDC authorization failed.';
      sendJson(response, 401, { error: message });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/auth/provider') {
    if (input.authMode !== 'local') {
      sendJson(response, 404, { error: 'Local provider is disabled.' });
      return true;
    }
    const form = new URLSearchParams(await requestBody(request));
    const login = form.get('login')?.trim();
    if (!login || !form.get('password')) {
      sendJson(response, 400, { error: 'Login and password are required.' });
      return true;
    }
    const userId = await input.auth.createLocalUser(login, form.get('role') ?? 'lawyer');
    const sessionId = randomUUID();
    await input.sessions.set(sessionId, { userId, createdAt: Date.now() }, input.sessionTtlSeconds);
    redirect(response, '/', [`monitoring_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/`]);
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/logout') {
    const session = request.headers.cookie?.match(/(?:^|;\s*)monitoring_session=([^;]+)/)?.[1];
    if (session) await input.sessions.delete(session);
    redirect(response, '/login', ['monitoring_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/']);
    return true;
  }

  return false;
}
