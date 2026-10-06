/**
 * Vercel function entry point — `POST /api/mcp` speaks MCP over Streamable
 * HTTP. The handler is created once per warm lambda; each request still gets
 * its own server instance (the SDK's stateless mode), so no session state
 * survives between requests.
 *
 * Set PW_MCP_HTTP_TOKEN in the Vercel project to serve all tools to callers
 * that send it as a bearer token; without it only read-only tools are served.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHttpHandler, handleNodeRequest } from '../dist/http.js';

const handler = createMcpHttpHandler();

export default function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleNodeRequest(handler, req, res);
}
