import { fileURLToPath } from 'node:url';

export type AuthMode = 'local' | 'oidc';
export type ObjectStorageDriver = 'local' | 's3';

export type AppConfig = Readonly<{
  port: number;
  databaseUrl: string;
  nodeEnv: string;
  authMode: AuthMode;
  sessionTtlSeconds: number;
  redisUrl?: string;
  keycloakIssuer?: string;
  keycloakClientId?: string;
  keycloakClientSecret?: string;
  keycloakRedirectUri?: string;
  oidcDefaultRole: string;
  objectStorageDriver: ObjectStorageDriver;
  storageDirectory: string;
  s3Endpoint?: string;
  s3Region: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle: boolean;
}>;

function numberValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { requireOidc?: boolean } = {}): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const authMode = (env.AUTH_MODE ?? (nodeEnv === 'production' ? 'oidc' : 'local')) as AuthMode;
  const objectStorageDriver = (env.OBJECT_STORAGE_DRIVER ?? 'local') as ObjectStorageDriver;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL in runtime/.env.');
  if (!['local', 'oidc'].includes(authMode)) throw new Error('AUTH_MODE must be local or oidc.');
  if (!['local', 's3'].includes(objectStorageDriver)) throw new Error('OBJECT_STORAGE_DRIVER must be local or s3.');
  if (options.requireOidc !== false && authMode === 'oidc' && (!env.KEYCLOAK_ISSUER || !env.KEYCLOAK_CLIENT_ID || !env.KEYCLOAK_REDIRECT_URI)) {
    throw new Error('OIDC mode requires KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID and KEYCLOAK_REDIRECT_URI.');
  }
  if (objectStorageDriver === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    throw new Error('S3 storage requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
  }
  return {
    port: numberValue(env.PORT, 4174),
    databaseUrl,
    nodeEnv,
    authMode,
    sessionTtlSeconds: numberValue(env.SESSION_TTL_SECONDS, 8 * 60 * 60),
    redisUrl: env.REDIS_URL,
    keycloakIssuer: env.KEYCLOAK_ISSUER?.replace(/\/$/, ''),
    keycloakClientId: env.KEYCLOAK_CLIENT_ID,
    keycloakClientSecret: env.KEYCLOAK_CLIENT_SECRET,
    keycloakRedirectUri: env.KEYCLOAK_REDIRECT_URI,
    oidcDefaultRole: env.OIDC_DEFAULT_ROLE ?? 'observer',
    objectStorageDriver,
    storageDirectory: fileURLToPath(new URL('../../storage/', import.meta.url)),
    s3Endpoint: env.S3_ENDPOINT,
    s3Region: env.S3_REGION ?? 'eu-central-1',
    s3Bucket: env.S3_BUCKET,
    s3AccessKeyId: env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  };
}
