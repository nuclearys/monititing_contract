import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AppConfig } from '../../infrastructure/config.js';
import type { SessionRecord, SessionStore } from '../../infrastructure/session-store.js';

const allowedRoles = new Set(['lawyer', 'deal_curator', 'fco', 'contract_manager', 'observer', 'administrator']);

type OidcDiscovery = Readonly<{ issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }>;

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function claimRoles(payload: Record<string, unknown>, fallback: string): string[] {
  const realmRoles = payload.realm_access && typeof payload.realm_access === 'object'
    ? (payload.realm_access as { roles?: unknown }).roles
    : [];
  const roles = [...(Array.isArray(realmRoles) ? realmRoles : []), ...(Array.isArray(payload.roles) ? payload.roles : [])]
    .filter((role): role is string => typeof role === 'string' && allowedRoles.has(role));
  return [...new Set(roles.length ? roles : [fallback].filter((role) => allowedRoles.has(role)))];
}

export function createAuthService(pool: Pool, sessions: SessionStore, config: AppConfig) {
  let discoveryPromise: Promise<OidcDiscovery> | null = null;

  async function createLocalUser(login: string, role: string): Promise<string> {
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
            SELECT 1 FROM user_access_scopes WHERE user_id = $1 AND scope_type = 'full_perimeter'
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

  async function discovery(): Promise<OidcDiscovery> {
    if (!config.keycloakIssuer) throw new Error('KEYCLOAK_ISSUER is not configured.');
    discoveryPromise ??= fetch(`${config.keycloakIssuer}/.well-known/openid-configuration`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}.`);
        return response.json() as Promise<OidcDiscovery>;
      });
    return discoveryPromise;
  }

  async function beginOidcLogin(): Promise<string> {
    const metadata = await discovery();
    const state = base64Url(randomBytes(32));
    const nonce = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    await sessions.set(`oidc-state:${state}`, { nonce, verifier }, 600);
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.keycloakClientId!,
      redirect_uri: config.keycloakRedirectUri!,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async function syncOidcUser(payload: Record<string, unknown>): Promise<string> {
    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) throw new Error('OIDC token has no subject.');
    const fullName = typeof payload.name === 'string'
      ? payload.name
      : typeof payload.preferred_username === 'string' ? payload.preferred_username : subject;
    const email = typeof payload.email === 'string' ? payload.email : null;
    const roles = claimRoles(payload, config.oidcDefaultRole);
    if (!roles.length) throw new Error('OIDC user has no mapped application role.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `
          INSERT INTO users (external_subject, full_name, email)
          VALUES ($1, $2, $3)
          ON CONFLICT (external_subject)
          DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email, is_active = true, updated_at = now()
          RETURNING id
        `,
        [`oidc:${subject}`, fullName, email],
      );
      const userId = user.rows[0].id;
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      for (const role of roles) {
        await client.query(
          `INSERT INTO user_roles (user_id, role) VALUES ($1, $2::user_role) ON CONFLICT DO NOTHING`,
          [userId, role],
        );
      }
      await client.query('COMMIT');
      return userId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeOidcLogin(url: URL): Promise<{ sessionId: string; userId: string }> {
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code) throw new Error('OIDC callback has no state or authorization code.');
    const pending = await sessions.get<{ nonce: string; verifier: string }>(`oidc-state:${state}`);
    await sessions.delete(`oidc-state:${state}`);
    if (!pending) throw new Error('OIDC login state expired.');
    const metadata = await discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.keycloakClientId!,
      code,
      redirect_uri: config.keycloakRedirectUri!,
      code_verifier: pending.verifier,
    });
    if (config.keycloakClientSecret) body.set('client_secret', config.keycloakClientSecret);
    const tokenResponse = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!tokenResponse.ok) throw new Error(`OIDC token exchange failed with HTTP ${tokenResponse.status}.`);
    const token = await tokenResponse.json() as { id_token?: string; access_token?: string };
    if (!token.id_token) throw new Error('OIDC token response has no id_token.');
    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    const verified = await jwtVerify(token.id_token, jwks, {
      issuer: metadata.issuer,
      audience: config.keycloakClientId,
    });
    if (verified.payload.nonce !== pending.nonce) throw new Error('OIDC nonce validation failed.');
    const userId = await syncOidcUser(verified.payload as Record<string, unknown>);
    const sessionId = randomUUID();
    await sessions.set(sessionId, { userId, createdAt: Date.now(), accessToken: token.access_token }, config.sessionTtlSeconds);
    return { sessionId, userId };
  }

  async function userIdFromRequest(request: IncomingMessage): Promise<string | null> {
    const cookie = request.headers.cookie?.match(/(?:^|;\s*)monitoring_session=([^;]+)/)?.[1];
    if (cookie) return (await sessions.get<SessionRecord>(cookie))?.userId ?? null;
    const devUserId = request.headers['x-dev-user-id'];
    if (config.authMode === 'local' && typeof devUserId === 'string') return devUserId;
    return null;
  }

  return { createLocalUser, beginOidcLogin, completeOidcLogin, userIdFromRequest };
}
