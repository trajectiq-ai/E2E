#!/usr/bin/env node
/**
 * playwright-e2e-mcp entry point.
 *
 * When executed (npx playwright-e2e-mcp / the `bin` shim) it connects
 * the MCP server over stdio. When imported it only exposes the API, so
 * tests and tooling can construct a server without side effects.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logger, createLogger } from './utils/logger.js';
import { SERVER_VERSION } from './server.js';

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(
      [
        'playwright-e2e-mcp — MCP server for running and debugging Playwright tests',
        '',
        'Usage: playwright-e2e-mcp [--version] [--help]',
        '',
        'Connects over stdio (MCP). Configuration via environment:',
        '  PW_MCP_PROJECT_ROOT        default project root (default: cwd)',
        '  PW_MCP_ALLOWED_ROOTS       extra roots callers may pass as projectRoot',
        '  PW_MCP_BLOCK_PRIVATE_URLS  1 = URL tools refuse private/loopback/metadata addresses',
        '  LOG_LEVEL / MCP_LOG_LEVEL  debug | info | warn | error | silent (default: info)',
        '  LOG_FORMAT / MCP_LOG_FORMAT  text | json (default: text)',
        '',
        'HTTP bridge only (api/mcp.ts, src/http.ts):',
        '  PW_MCP_HTTP_TOKEN          bearer token (16+ chars) that unlocks all tools',
        '  PW_MCP_ALLOWED_HOSTS       Host allowlist, comma separated (* = any)',
        '  PW_MCP_PASSTHROUGH_ENV     extra variables passed to test runs',
        '  PW_MCP_MAX_CHILDREN        concurrent runs (default: 4)',
        '',
      ].join('\n'),
    );
    return;
  }

  const { startServer } = await import('./server.js');
  await startServer();
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    const log = createLogger({ bindings: { name: 'playwright-e2e-mcp' } });
    log.error('server failed to start', { error: err });
    process.exit(1);
  });
}

export { createServer, startServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export { createMcpHttpHandler, handleNodeRequest, MAX_BODY_BYTES } from './http.js';
export { logger };
