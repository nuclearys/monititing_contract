import { createClient } from 'redis';

export type SessionRecord = Readonly<{
  userId: string;
  createdAt: number;
  accessToken?: string;
}>;

export interface SessionStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const item = this.values.get(key);
    if (!item || item.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return item.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async close(): Promise<void> {
    this.values.clear();
  }
}

export class RedisSessionStore implements SessionStore {
  private readonly client;
  private readonly ready: Promise<void>;

  constructor(private readonly redisUrl: string, private readonly prefix = 'monitoring:') {
    this.client = createClient({ url: this.redisUrl });
    this.client.on('error', (error) => console.error('Redis session store error:', error));
    this.ready = this.client.connect().then(() => undefined);
  }

  private async connected(): Promise<void> {
    await this.ready;
  }

  async get<T>(key: string): Promise<T | null> {
    await this.connected();
    const raw = await this.client.get(`${this.prefix}${key}`);
    return raw ? JSON.parse(raw) as T : null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.connected();
    await this.client.setEx(`${this.prefix}${key}`, ttlSeconds, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.connected();
    await this.client.del(`${this.prefix}${key}`);
  }

  async close(): Promise<void> {
    await this.connected();
    await this.client.quit();
  }
}

export async function createSessionStore(redisUrl: string | undefined): Promise<SessionStore> {
  if (!redisUrl) return new MemorySessionStore();
  const store = new RedisSessionStore(redisUrl);
  await store.get('__healthcheck__');
  return store;
}
