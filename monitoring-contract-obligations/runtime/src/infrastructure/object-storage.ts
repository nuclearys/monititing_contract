import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from './config.js';

export type MaterializedObject = Readonly<{
  filePath: string;
  cleanup(): Promise<void>;
}>;

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  materialize(key: string): Promise<MaterializedObject>;
}

function safeLocalPath(root: string, key: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, key);
  if (target !== rootPath && !target.startsWith(`${rootPath}/`)) throw new Error('Unsafe storage key.');
  return target;
}

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  async put(key: string, body: Buffer): Promise<void> {
    const target = safeLocalPath(this.root, key);
    await mkdir(this.root, { recursive: true });
    await writeFile(target, body);
  }

  async remove(key: string): Promise<void> {
    await rm(safeLocalPath(this.root, key), { force: true });
  }

  async materialize(key: string): Promise<MaterializedObject> {
    const filePath = safeLocalPath(this.root, key);
    await readFile(filePath);
    return { filePath, cleanup: async () => undefined };
  }
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    endpoint: string | undefined,
    accessKeyId: string,
    secretAccessKey: string,
    forcePathStyle: boolean,
  ) {
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async remove(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async materialize(key: string): Promise<MaterializedObject> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`Object storage returned no body for ${basename(key)}.`);
    const body = Buffer.from(await result.Body.transformToByteArray());
    const directory = join(tmpdir(), `monitoring-object-${randomUUID()}`);
    const filePath = join(directory, basename(key));
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, body);
    return { filePath, cleanup: async () => rm(directory, { recursive: true, force: true }) };
  }
}

export function createObjectStorage(config: AppConfig): ObjectStorage {
  if (config.objectStorageDriver === 's3') {
    return new S3ObjectStorage(
      config.s3Bucket!,
      config.s3Region,
      config.s3Endpoint,
      config.s3AccessKeyId!,
      config.s3SecretAccessKey!,
      config.s3ForcePathStyle,
    );
  }
  return new LocalObjectStorage(config.storageDirectory);
}
