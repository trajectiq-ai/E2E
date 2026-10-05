/**
 * Streamable HTTP bridge for the MCP server.
 *
 * `createMcpHandler` (MCP SDK) is fetch-shaped: it answers the 2025
 * streamable-HTTP transport *statelessly* — a fresh server per request, which
 * is exactly what a serverless function wants — and the modern envelope
 * transport on the same URL. This module adds the thin adapter for runtimes
 * that hand you Node's `IncomingMessage`/`ServerResponse` pair (Vercel
 * functions, a plain `node:http` server), so the very same code path can be
 * verified locally before it is deployed.
 *
 * The stdio transport in server.ts is untouched; this is an additional way to
 * reach the same eight tools.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';

/** Mirrors the SDK's default POST body bound, so oversized bodies die early. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Build the fetch-shaped MCP handler backed by a fresh server per request. */
export function createMcpHttpHandler(): McpHttpHandler {
  return createMcpHandler(() => createServer(), {
    legacy: 'stateless',
    onerror: (error: Error) => logger.error('mcp http handler error', { error }),
  });
}

/** A failure that maps onto an HTTP status before any response is written. */
class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new RequestError(413, 'request body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

function buildRequest(req: IncomingMessage, method: string, body: Buffer | undefined): Request {
  const protocol = (firstHeader(req.headers['x-forwarded-proto']) ?? 'http').split(',')[0].trim();
  const host = firstHeader(req.headers.host) ?? 'localhost';
  const init: RequestInit = { method, headers: toHeaders(req.headers) };
  if (body && body.byteLength > 0) init.body = body;
  return new Request(`${protocol}://${host}${req.url ?? '/'}`, init);
}

/** Resolve when the socket drains or closes, so a dead client cannot hang us. */
function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/**
 * Serve one Node request through the MCP handler.
 *
 * Always settles: a transport failure becomes a JSON error response, and a
 * mid-stream failure closes the socket so the client stops waiting.
 */
export async function handleNodeRequest(
  handler: McpHttpHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let response: Response;
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    response = await handler.fetch(buildRequest(req, method, body));
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    if (status !== 413 && !(err instanceof RequestError)) {
      logger.error('mcp http request failed', { error: err });
    }
    if (!res.headersSent && !res.writableEnded) {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    } else if (!res.writableEnded) {
      res.destroy();
    }
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // Let Node choose chunked framing for streamed bodies.
    if (key.toLowerCase() === 'content-length' && response.body) return;
    res.setHeader(key, value);
  });

  const body = response.body;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  try {
    for (;;) {
      if (res.destroyed || res.writableEnded) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0 && !res.write(Buffer.from(value))) {
        await waitDrain(res);
      }
    }
  } catch (err) {
    logger.warn('mcp http response stream failed', { error: err });
    if (!res.writableEnded) res.destroy();
    return;
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!res.writableEnded) res.end();
}
