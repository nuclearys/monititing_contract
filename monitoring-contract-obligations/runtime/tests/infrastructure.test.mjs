import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { LocalObjectStorage } from '../src/infrastructure/object-storage.ts';
import { MemorySessionStore } from '../src/infrastructure/session-store.ts';

test('memory session store expires sessions', async () => {
  const store = new MemorySessionStore();
  await store.set('session', { userId: 'user-1' }, 0.001);
  assert.deepEqual(await store.get('session'), { userId: 'user-1' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.get('session'), null);
  await store.close();
});

test('local object storage prevents path traversal and materializes files', async () => {
  const root = join('/private/tmp', `monitoring-storage-test-${Date.now()}`);
  const storage = new LocalObjectStorage(root);
  await storage.put('sample.txt', Buffer.from('hello'), 'text/plain');
  const materialized = await storage.materialize('sample.txt');
  assert.equal(await readFile(materialized.filePath, 'utf8'), 'hello');
  await assert.rejects(() => storage.put('../outside.txt', Buffer.from('bad'), 'text/plain'), /Unsafe storage key/);
  await materialized.cleanup();
  await storage.remove('sample.txt');
});
