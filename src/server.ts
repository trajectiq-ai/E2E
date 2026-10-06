/**
 * MCP server setup: creates the McpServer instance, registers the eight
 * tools (with spec tool annotations), and wires each invocation to a ToolContext (per-tool logger,
 * abort signal, shared store, default project root).
 *
 * Logs go to stderr only — stdout belongs to the MCP protocol.
 */

import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import type { ServerContext, StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server';
import type { ToolContext, ToolResponse, ToolStore } from './types/index.js';
import { toPlaywrightMcpError } from './types/index.js';
import { logger } from './utils/logger.js';
import { killActiveChildren } from './utils/playwright-runner.js';
import { createToolStore, toolError } from './tools/shared.js';
import { runTestTool } from './tools/run-test.js';
import { getFailureTool } from './tools/get-failure.js';
import { inspectPageTool } from './tools/inspect-page.js';
import { listTestsTool } from './tools/list-tests.js';
import { validateSelectorTool } from './tools/validate-selector.js';
import { generateE2ETestTool } from './tools/generate-e2e-test.js';
import { compareVisualStateTool } from './tools/compare-visual-state.js';
import { diagnoseFlakyTool } from './tools/diagnose-flaky.js';

const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_NAME = 'playwright-e2e-mcp';
export const SERVER_VERSION = readVersion();

interface ToolSpec {
  name: string;
  title: string;
  description: string;
  /** Standard Schema object (zod v4 `z.object(…)`), as required by MCP SDK v2. */
  inputSchema: StandardSchemaWithJSON;
  /** Spec tool annotations so clients can classify safety before calling. */
  annotations: ToolAnnotations;
  /** `never` keeps the registry homogeneous; each tool narrows on use. */
  handler: (args: never, ctx: ToolContext) => Promise<ToolResponse>;
}

const TOOLS: ToolSpec[] = [
  {
    ...runTestTool,
    title: 'Run E2E tests',
    // Spawns Playwright, which runs the project's own test code (arbitrary
    // Node), hits live apps and writes test-results/ artifacts.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: runTestTool.handler as ToolSpec['handler'],
  },
  {
    ...getFailureTool,
    title: 'Analyze a test failure',
    // Pure reads: JSON report, trace.zip, generated failure summaries.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getFailureTool.handler as ToolSpec['handler'],
  },
  {
    ...inspectPageTool,
    title: 'Inspect live page DOM',
    // Navigates and evaluates read-only DOM queries; never clicks or types.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: inspectPageTool.handler as ToolSpec['handler'],
  },
  {
    ...listTestsTool,
    title: 'List available tests',
    // Parses test files and config without modifying them.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: listTestsTool.handler as ToolSpec['handler'],
  },
  {
    ...validateSelectorTool,
    title: 'Validate CSS selector',
    // Opens a page and queries the selector; no state-changing actions.
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: validateSelectorTool.handler as ToolSpec['handler'],
  },
  {
    ...generateE2ETestTool,
    title: 'Generate an E2E test',
    // Writes a spec file; with overwrite it replaces a spec it generated
    // earlier, never any other file.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: generateE2ETestTool.handler as ToolSpec['handler'],
  },
  {
    ...compareVisualStateTool,
    title: 'Compare visual state',
    // Navigates the app; the baseline action overwrites a stored baseline.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: compareVisualStateTool.handler as ToolSpec['handler'],
  },
  {
    ...diagnoseFlakyTool,
    title: 'Diagnose flaky test',
    // Spawns Playwright repeatedly, running the project's test code.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: diagnoseFlakyTool.handler as ToolSpec['handler'],
  },
];

export interface CreateServerOptions {
  /** Default project root for tool calls (defaults to cwd / env var). */
  projectRoot?: string;
  /** Share a store across servers (tests). */
  store?: ToolStore;
  /** Register only these tools (default: all). Used by the hosted HTTP bridge. */
  tools?: readonly string[];
}

/**
 * Tools that neither spawn processes, drive a browser nor write files.
 * The HTTP bridge serves only these unless it is protected by a token.
 */
export const READ_ONLY_TOOLS: readonly string[] = ['list-tests', 'get-failure'];

export function resolveDefaultProjectRoot(): string {
  const fromEnv = process.env.PW_MCP_PROJECT_ROOT;
  // A host that collects PW_MCP_PROJECT_ROOT via MCPB user_config but does
  // not substitute `${user_config.project_root}` would pass the placeholder
  // through verbatim; that can never be a real path, so fall back to cwd.
  if (fromEnv && fromEnv.includes('${')) {
    logger.warn('PW_MCP_PROJECT_ROOT contains an unsubstituted ${...} placeholder; using cwd', {
      value: fromEnv,
    });
    return process.cwd();
  }
  const root = fromEnv && fromEnv.trim() !== '' ? fromEnv : process.cwd();
  if (fromEnv) {
    try {
      statSync(root);
    } catch {
      logger.warn('PW_MCP_PROJECT_ROOT does not exist; tool calls will fail until it does', { root });
    }
  }
  return root;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const projectRoot = options.projectRoot ?? resolveDefaultProjectRoot();
  const store = options.store ?? createToolStore();
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const enabled = options.tools ? TOOLS.filter((tool) => options.tools?.includes(tool.name)) : TOOLS;
  for (const tool of enabled) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown, reqCtx: ServerContext) => {
        const ctx: ToolContext = {
          logger: logger.child({ tool: tool.name }),
          // v2: the request abort signal lives under ctx.mcpReq.
          signal: reqCtx.mcpReq.signal,
          store,
          projectRoot,
        };
        try {
          return await tool.handler(args as never, ctx);
        } catch (err) {
          // Backstop: tools already convert their own errors via guard().
          const error = toPlaywrightMcpError(err);
          ctx.logger.error('tool threw unexpectedly', { error, kind: error.kind });
          return toolError(error.kind, error.message, error.hint, error.details);
        }
      },
    );
  }

  logger.debug('server created', { version: SERVER_VERSION, projectRoot, tools: enabled.length });
  return server;
}

let shuttingDown = false;

/** Close the server, kill orphaned children, and exit. */
export async function shutdown(server: McpServer, code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const killed = killActiveChildren();
  logger.info('shutting down', { reason, killedProcesses: killed });
  try {
    await server.close();
  } catch (err) {
    logger.warn('error while closing server', { error: err });
  }
  process.exit(code);
}

/** Connect the server over stdio and install shutdown handlers. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  process.on('SIGINT', () => void shutdown(server, 0, 'SIGINT'));
  process.on('SIGTERM', () => void shutdown(server, 0, 'SIGTERM'));
  // The client went away: stdin ends, and we must not leave browsers or
  // test workers running.
  process.stdin.on('end', () => void shutdown(server, 0, 'stdin ended (client disconnected)'));
  process.stdin.on('close', () => void shutdown(server, 0, 'stdin closed (client disconnected)'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { error: err });
    void shutdown(server, 1, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { error: reason });
    void shutdown(server, 1, 'unhandledRejection');
  });

  await server.connect(transport);
  logger.info('connected over stdio', {
    version: SERVER_VERSION,
    projectRoot: resolveDefaultProjectRoot(),
    tools: TOOLS.map((tool) => tool.name),
  });
}
