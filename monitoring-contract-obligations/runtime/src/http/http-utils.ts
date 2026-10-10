import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  response.writeHead(302, { location, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  response.end();
}

export async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function requestBuffer(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export type MultipartPart = Readonly<{ name: string; fileName?: string; mimeType?: string; value: string | Buffer }>;

export function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
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
        parts.push({ name: disposition[1], fileName: disposition[2] || undefined, mimeType: mime, value: disposition[2] ? data : data.toString('utf8') });
      }
    }
    cursor = nextBoundary;
  }
  return parts;
}

export function multipartValue(parts: MultipartPart[], name: string): string {
  const part = parts.find((item) => item.name === name && typeof item.value === 'string');
  return typeof part?.value === 'string' ? part.value.trim() : '';
}

export async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await requestBody(request));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
