/**
 * Structured logging for the MCP server.
 *
 * IMPORTANT: MCP over stdio reserves stdout for protocol messages, so
 * every log line is written to stderr. Logging must never throw — a full
 * disk or closed stream must not take the server down.
 */

import type { LogContext, LogLevel, Logger } from '../types/index.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface LogStream {
  write(chunk: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'text' | 'json';
  bindings?: LogContext;
  stream?: LogStream;
}

function parseLevel(raw: string | undefined): LogLevel | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVEL_ORDER, value) ? (value as LogLevel) : undefined;
}

function parseFormat(raw: string | undefined): 'text' | 'json' | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  return value === 'json' || value === 'ndjson' ? 'json' : value === 'text' ? 'text' : undefined;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: String(err.cause) } : {}),
    };
  }
  return { message: String(err) };
}

function normalizeContext(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function formatContextText(context: LogContext): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    parts.push(`${key}=${stringifyValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

class StdLogger implements Logger {
  readonly level: LogLevel;
  private readonly format: 'text' | 'json';
  private readonly bindings: LogContext;
  private readonly stream: LogStream;

  constructor(level: LogLevel, format: 'text' | 'json', bindings: LogContext, stream: LogStream) {
    this.level = level;
    this.format = format;
    this.bindings = bindings;
    this.stream = stream;
  }

  private enabled(level: LogLevel): boolean {
    if (this.level === 'silent') return false;
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private emit(level: Exclude<LogLevel, 'silent'>, message: string, context?: LogContext): void {
    if (!this.enabled(level)) return;
    try {
      const merged = normalizeContext({ ...this.bindings, ...(context ?? {}) });
      if (this.format === 'json') {
        this.stream.write(
          `${JSON.stringify({ time: new Date().toISOString(), level, message, ...merged })}\n`,
        );
      } else {
        const name = typeof merged.name === 'string' ? ` [${merged.name}]` : '';
        delete merged.name;
        this.stream.write(
          `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)}${name} ${message}${formatContextText(merged)}\n`,
        );
      }
    } catch {
      // Logging must never break the server (e.g. closed pipe, full disk).
    }
  }

  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }

  child(bindings: LogContext): Logger {
    return new StdLogger(this.level, this.format, { ...this.bindings, ...bindings }, this.stream);
  }
}

/** Create a logger. Defaults come from LOG_LEVEL / LOG_FORMAT env vars. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? parseLevel(process.env.LOG_LEVEL ?? process.env.MCP_LOG_LEVEL) ?? 'info';
  const format = options.format ?? parseFormat(process.env.LOG_FORMAT ?? process.env.MCP_LOG_FORMAT) ?? 'text';
  const stream = options.stream ?? {
    write: (chunk: string): void => {
      process.stderr.write(chunk);
    },
  };
  return new StdLogger(level, format, options.bindings ?? {}, stream);
}

/** Shared root logger used across the server. */
export const logger: Logger = createLogger({ bindings: { name: 'playwright-e2e-mcp' } });
