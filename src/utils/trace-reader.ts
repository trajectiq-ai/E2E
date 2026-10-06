/**
 * Playwright trace reader.
 *
 * `get-failure` uses this to deliver the "magic" context from the
 * blueprint: the exact error, the action that failed, the action log
 * leading up to it, the DOM snapshot Playwright captured around the
 * failure, and (when present) the `error-context` accessibility-tree
 * attachment Playwright writes for failed expectations.
 *
 * trace.zip is a plain ZIP archive (deflate or stored) containing
 * `*.trace` JSON-lines event logs plus resources (snapshots,
 * screencasts, attachments). Real schema (Playwright 1.63, trace v9):
 *
 *   {"type":"before","callId":"pw:api@43","class":"Test","method":"pw:api",
 *    "title":"Navigate","params":{"url":"/"},"startTime":955.76}
 *   {"type":"after","callId":"pw:api@43","endTime":1005.7,
 *    "error":{"message":"page.goto: net::ERR_CONNECTION_REFUSED …"}}
 *   {"type":"frame-snapshot","callId":"call@11","phase":"before",
 *    "snapshot":{"html":["HTML",{},["BODY",{},[…]]]}}
 *   {"type":"error","message":"…"}        // standalone error event
 *
 * Legacy synthetic fields (`api`, string `snapshot` hashes, `error`
 * directly) are also supported. Everything is parsed with Node
 * built-ins — no dependencies.
 */

import { readFile } from 'node:fs/promises';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { normalizePath } from './path-utils.js';

/** Upper bound for any single decompressed trace entry (zip-bomb guard). */
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const INFLATE_LIMIT = { maxOutputLength: MAX_INFLATED_BYTES };

/** Cap so one huge trace cannot blow up the tool payload. */
const MAX_HTML_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_ACTION_LOG = 12;
const MAX_SNIPPET_RADIUS = 900;
const MAX_FAILED_REQUESTS = 8;
const MAX_CONSOLE_MESSAGES = 10;

/** Hooks/fixtures are noise in the action log. */
const NOISE_METHODS = new Set(['hook', 'fixture']);

export interface TraceActionLogEntry {
  api: string;
  summary: string;
  failed: boolean;
}

/** A request that failed (4xx/5xx, transport error, or no response). */
export interface TraceFailedRequest {
  method: string;
  url: string;
  /** HTTP status; undefined when the request never completed. */
  status?: number;
  statusText?: string;
  /** Playwright resource type (document, fetch, xhr, script, …). */
  resourceType?: string;
  /** Transport-level error text, when Playwright recorded one. */
  errorText?: string;
}

/** A console error/warning the page logged before the failure. */
export interface TraceConsoleMessage {
  type: 'error' | 'warning';
  text: string;
  /** `url:line` of the log call, when known. */
  location?: string;
}

export interface FailureTraceContext {
  /** Error message recorded in the trace (or best-effort text). */
  error: string;
  /** The action that was in flight when the error happened. */
  action?: { api: string; selector?: string; params?: string };
  /** Timestamp of the failure relative to trace start (ms), if known. */
  atMs?: number;
  /** Raw DOM snapshot from the trace (already capped). */
  snapshotHtml?: string;
  snapshotTruncated?: boolean;
  /** Window of HTML around the failing element, when locatable. */
  snippet?: string;
  /** Playwright's `error-context` attachment (accessibility tree at failure). */
  errorContext?: string;
  /** Recent actions before the failure, oldest first. */
  actionLog: TraceActionLogEntry[];
  /** Requests that failed (4xx/5xx/no-response) during the test. */
  failedRequests: TraceFailedRequest[];
  /** Total completed requests observed in the trace (context for the cap). */
  networkTotal: number;
  /** Console errors/warnings logged before the failure, oldest first. */
  consoleMessages: TraceConsoleMessage[];
  /** Non-fatal parsing issues (missing snapshot, unknown format…). */
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP reader                                                  */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Read a ZIP archive into a name → raw bytes map (built-ins only). */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const central: Array<[string, ZipEntry]> = [];
  for (let i = 0; i < entryCount && i < 50_000; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    central.push([name, { compressionMethod, compressedSize, localHeaderOffset }]);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  for (const [name, entry] of central) {
    const lh = entry.localHeaderOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) continue;
    const nameLength = buf.readUInt16LE(lh + 26);
    const extraLength = buf.readUInt16LE(lh + 28);
    const start = lh + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > buf.length) continue;
    const raw = buf.subarray(start, end);
    try {
      if (entry.compressionMethod === 0) out.set(name, Buffer.from(raw));
      else if (entry.compressionMethod === 8) out.set(name, inflateRawSync(raw, INFLATE_LIMIT));
    } catch {
      // Skip unreadable entry; callers surface missing snapshots as warnings.
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Serialization helpers                                               */
/* ------------------------------------------------------------------ */

interface TraceEvent {
  type?: string;
  version?: number;
  callId?: string;
  class?: string;
  method?: string;
  title?: string;
  params?: Record<string, unknown>;
  error?: unknown;
  message?: string;
  snapshot?: unknown;
  attachments?: Array<{ name?: string; contentType?: string; file?: string }>;
  startTime?: number;
  endTime?: number;
  time?: number;
  /** Console events (type === 'console'). */
  messageType?: string;
  text?: string;
  location?: { url?: string; lineNumber?: number };
  /** Legacy/synthetic fields. */
  api?: string;
  [key: string]: unknown;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Playwright serializes DOM snapshots as tagged arrays:
 *   ["HTML", {"attr": "v"}, ["BODY", {}, ["hello"]]]
 * Render them back to inspectable HTML.
 */
export function serializeDomTree(node: unknown, depth = 0): string | undefined {
  if (depth > 200) return undefined;
  if (typeof node === 'string') return escapeHtml(node);
  if (!Array.isArray(node) || node.length === 0) return undefined;

  const tag = node[0];
  if (typeof tag !== 'string') return undefined;
  if (tag.startsWith('#')) {
    // Text/comment nodes carry their content in [1] or as siblings.
    const text = node[1];
    return typeof text === 'string' ? escapeHtml(text) : '';
  }

  const attrs = node[1] && typeof node[1] === 'object' && !Array.isArray(node[1]) ? (node[1] as Record<string, unknown>) : {};
  const children = node.slice(Array.isArray(node[1]) || typeof node[1] !== 'object' || node[1] === null ? 1 : 2);

  let attrText = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (name.startsWith('#') || value === undefined || value === null) continue;
    const rendered = typeof value === 'string' ? value : String(value);
    attrText += ` ${name}="${escapeHtml(rendered)}"`;
  }

  const inner = children
    .map((child) => serializeDomTree(child, depth + 1) ?? '')
    .join('');
  return `<${tag.toLowerCase()}${attrText}>${inner}</${tag.toLowerCase()}>`;
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Error carried by an event: `error` field, or standalone type:'error'. */
function eventError(event: TraceEvent): string | undefined {
  if (event.error !== undefined) return errorMessage(event.error);
  if (event.type === 'error' && typeof event.message === 'string' && event.message.trim() !== '') {
    return event.message;
  }
  return undefined;
}

function summarizeParams(params: Record<string, unknown> | undefined): {
  summary: string;
  selector?: string;
} {
  if (!params) return { summary: '' };
  const parts: string[] = [];
  let selector: string | undefined;
  for (const [key, value] of Object.entries(params)) {
    if (key === 'element' || key === 'stack') continue;
    let text: string | undefined;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
    else if (value && typeof value === 'object') {
      const inner = value as { selector?: unknown };
      if (typeof inner.selector === 'string') text = inner.selector;
      else continue;
    }
    if (text === undefined) continue;
    if (key === 'selector') selector = text;
    if (parts.length < 3) {
      parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
    }
  }
  return { summary: parts.join(' '), selector };
}

interface ActionInfo {
  api: string;
  summary: string;
  selector?: string;
  startTime?: number;
  callId?: string;
}

function actionInfo(event: TraceEvent): ActionInfo | undefined {
  if (typeof event.api === 'string') {
    const { summary, selector } = summarizeParams(event.params);
    return { api: event.api, summary, selector, startTime: event.startTime, callId: event.callId };
  }
  if (event.type !== 'before') return undefined;
  if (typeof event.method === 'string' && NOISE_METHODS.has(event.method)) return undefined;
  const { summary, selector } = summarizeParams(event.params);
  const api =
    (typeof event.title === 'string' && event.title !== '' ? event.title : undefined) ??
    [event.class, event.method].filter(Boolean).join('.') ??
    'step';
  return { api, summary, selector, startTime: event.startTime, callId: event.callId };
}

/* ------------------------------------------------------------------ */
/* Event analysis                                                      */
/* ------------------------------------------------------------------ */

interface SnapshotCandidate {
  html?: string;
  hash?: string;
  callId?: string;
  time?: number;
}

function snapshotFrom(event: TraceEvent): { html?: string; hash?: string } {
  const snapshot = event.snapshot;
  if (typeof snapshot === 'string') return { hash: snapshot };
  if (snapshot && typeof snapshot === 'object') {
    const s = snapshot as { html?: unknown; hash?: unknown };
    if (typeof s.hash === 'string') return { hash: s.hash };
    if (s.html !== undefined) {
      const html = serializeDomTree(s.html);
      if (html) return { html };
    }
  }
  return {};
}

/**
 * Parse merged `.trace` JSON-lines into a structured failure context.
 * Exported for unit tests with synthetic event streams.
 */
export function analyzeTraceEvents(
  lines: string | string[],
  snapshotLoader: (hash: string) => string | undefined,
  fileLoader?: (name: string) => string | undefined,
): FailureTraceContext {
  const rawLines = Array.isArray(lines) ? lines : lines.split(/\r?\n/);
  const warnings: string[] = [];
  const actionLog: TraceActionLogEntry[] = [];
  const consoleMessages: TraceConsoleMessage[] = [];
  const events: TraceEvent[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // Tolerate partial lines from a killed run.
    }
  }
  if (events.length === 0) {
    warnings.push('The trace contained no parseable events (the run may have been killed mid-write).');
  }

  let firstTimestamp: number | undefined;
  const pendingByCall = new Map<string, ActionInfo>();
  let pendingSingle: ActionInfo | undefined;
  const snapshots: SnapshotCandidate[] = [];
  const beforeTime = new Map<string, number>();
  let currentHash: string | undefined;
  let errorContextFile: string | undefined;

  let failure:
    | { error: string; action?: ActionInfo; time?: number; callId?: string; hash?: string; html?: string }
    | undefined;

  const recordAction = (entry: TraceActionLogEntry): void => {
    actionLog.push(entry);
    if (actionLog.length > MAX_ACTION_LOG) actionLog.shift();
  };

  const takePending = (event: TraceEvent): ActionInfo | undefined => {
    if (event.callId) {
      const info = pendingByCall.get(event.callId);
      if (info) pendingByCall.delete(event.callId);
      return info;
    }
    const info = pendingSingle;
    pendingSingle = undefined;
    return info;
  };

  for (const event of events) {
    const time = event.startTime ?? event.time ?? event.endTime;
    if (time !== undefined && firstTimestamp === undefined) firstTimestamp = time;

    if (event.type === 'console') {
      const kind =
        event.messageType === 'error'
          ? 'error'
          : event.messageType === 'warning'
            ? 'warning'
            : undefined;
      if (kind) {
        const loc = event.location;
        consoleMessages.push({
          type: kind,
          text: typeof event.text === 'string' ? event.text : '',
          location:
            loc?.url !== undefined
              ? `${loc.url}${loc.lineNumber !== undefined ? `:${loc.lineNumber}` : ''}`
              : undefined,
        });
        if (consoleMessages.length > MAX_CONSOLE_MESSAGES) consoleMessages.shift();
      }
    }

    if (event.snapshot !== undefined) {
      const { html, hash } = snapshotFrom(event);
      if (hash) currentHash = hash;
      if (html || hash) {
        snapshots.push({
          html,
          hash,
          callId: event.callId,
          time: event.startTime ?? (event.callId ? beforeTime.get(event.callId) : undefined),
        });
      }
    }

    const started = actionInfo(event);
    if (started) {
      if (started.startTime !== undefined && started.callId) beforeTime.set(started.callId, started.startTime);
      if (started.callId) pendingByCall.set(started.callId, started);
      else pendingSingle = started;
    }

    for (const attachment of event.attachments ?? []) {
      const name = attachment.name ?? '';
      const contentType = attachment.contentType ?? '';
      if (attachment.file && (name === 'error-context' || contentType === 'text/markdown')) {
        errorContextFile = attachment.file;
      }
    }

    const error = eventError(event);
    if (error !== undefined && !failure) {
      const info = takePending(event);
      const snap = snapshotFrom(event);
      failure = {
        error,
        action: info,
        time: event.endTime ?? event.startTime ?? event.time ?? info?.startTime,
        callId: event.callId ?? info?.callId,
        hash: snap.hash,
        html: snap.html,
      };
      if (info) recordAction({ api: info.api, summary: info.summary, failed: true });
      continue;
    }

    if (event.type === 'after') {
      const info = takePending(event);
      if (info) {
        recordAction({ api: info.api, summary: info.summary, failed: eventError(event) !== undefined });
      }
    }
  }

  // Steps still in flight when the trace ended (killed run).
  for (const info of pendingByCall.values()) {
    if (!NOISE_METHODS.has(info.api.toLowerCase())) {
      recordAction({ api: info.api, summary: info.summary, failed: false });
    }
  }
  if (pendingSingle) {
    recordAction({ api: pendingSingle.api, summary: pendingSingle.summary, failed: false });
  }

  // Choose the snapshot closest to (but not after) the failure.
  let chosen: SnapshotCandidate | undefined;
  if (failure) {
    if (failure.callId) chosen = [...snapshots].reverse().find((s) => s.callId === failure.callId);
    if (!chosen && failure.time !== undefined) {
      chosen = [...snapshots]
        .filter((s) => s.time === undefined || s.time <= (failure.time as number))
        .pop();
    }
    if (!chosen) chosen = snapshots[snapshots.length - 1];
  }
  const snapshotHash = failure?.hash ?? chosen?.hash ?? currentHash;
  const snapshotTreeHtml = failure?.html ?? chosen?.html;

  let snapshotHtml: string | undefined;
  let snapshotTruncated = false;
  const truncate = (html: string): string => {
    if (html.length > MAX_HTML_CHARS) {
      snapshotTruncated = true;
      return html.slice(0, MAX_HTML_CHARS);
    }
    return html;
  };

  if (snapshotTreeHtml) {
    snapshotHtml = truncate(snapshotTreeHtml);
  } else if (snapshotHash) {
    const loaded = snapshotLoader(snapshotHash);
    if (loaded === undefined) {
      warnings.push(`DOM snapshot "${snapshotHash}" was not present in the trace archive.`);
    } else {
      snapshotHtml = truncate(loaded);
    }
  } else if (events.length > 0) {
    warnings.push('No DOM snapshot was recorded before the failure (the page may never have loaded).');
  }

  let errorContext: string | undefined;
  if (errorContextFile && fileLoader) {
    const content = fileLoader(errorContextFile);
    if (content && content.trim() !== '') {
      errorContext =
        content.length > MAX_CONTEXT_CHARS ? `${content.slice(0, MAX_CONTEXT_CHARS)}…` : content;
    }
  }

  const context: FailureTraceContext = {
    error:
      failure?.error ??
      (events.length > 0 ? 'The trace recorded an error without a message.' : 'No trace data.'),
    action: failure?.action
      ? {
          api: failure.action.api,
          selector: failure.action.selector,
          params: failure.action.summary,
        }
      : undefined,
    atMs:
      failure?.time !== undefined && firstTimestamp !== undefined
        ? Math.max(0, Math.round(failure.time - firstTimestamp))
        : undefined,
    snapshotHtml,
    snapshotTruncated,
    errorContext,
    actionLog,
    consoleMessages,
    failedRequests: [],
    networkTotal: 0,
    warnings,
  };

  const snippet = buildSnippet(snapshotHtml, failure?.action?.selector);
  if (snippet) context.snippet = snippet;

  return context;
}

/** Window of snapshot HTML around the failing element, when locatable. */
function buildSnippet(html: string | undefined, selector: string | undefined): string | undefined {
  if (!html) return undefined;
  const candidates: string[] = [];
  if (selector) {
    candidates.push(selector);
    const id = /#([\w-]+)/.exec(selector);
    if (id) candidates.push(`id="${id[1]}"`);
    const cls = /\.([\w-]+)/.exec(selector);
    if (cls) candidates.push(cls[1]);
    const attr = /\[([\w-]+)=["']?([^"'\]]+)/.exec(selector);
    if (attr) candidates.push(`${attr[1]}="${attr[2]}"`);
  }

  for (const candidate of candidates) {
    if (candidate === '') continue;
    const index = html.indexOf(candidate);
    if (index < 0) continue;
    const start = Math.max(0, index - MAX_SNIPPET_RADIUS);
    const end = Math.min(html.length, index + candidate.length + MAX_SNIPPET_RADIUS);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < html.length ? '…' : '';
    return `${prefix}${html.slice(start, end)}${suffix}`;
  }

  // Fall back to the start of <body> so the agent still gets real DOM.
  const body = html.indexOf('<body');
  if (body >= 0) return html.slice(body, Math.min(html.length, body + MAX_SNIPPET_RADIUS * 2));
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function loadFromZip(entries: Map<string, Buffer>, names: string[]): string | undefined {
  for (const name of names) {
    const buf = entries.get(name);
    if (!buf) continue;
    try {
      return gunzipSync(buf, INFLATE_LIMIT).toString('utf8');
    } catch {
      try {
        return inflateRawSync(buf, INFLATE_LIMIT).toString('utf8');
      } catch {
        return buf.toString('utf8');
      }
    }
  }
  return undefined;
}

function loadSnapshotSync(entries: Map<string, Buffer>, hash: string): string | undefined {
  return loadFromZip(entries, [`resources/${hash}`, hash, `${hash}.html`, `resources/${hash}.html`]);
}

/** Decode a trace entry that may be raw JSON, deflated or gzipped. */
function decodeEntryText(data: Buffer): string {
  try {
    return gunzipSync(data, INFLATE_LIMIT).toString('utf8');
  } catch {
    try {
      return inflateRawSync(data, INFLATE_LIMIT).toString('utf8');
    } catch {
      return data.toString('utf8');
    }
  }
}

/**
 * Parse a Playwright `*.network` JSON-lines entry (HAR-style
 * `resource-snapshot` events) and return the requests that failed
 * (status >= 400, status 0, transport error, or no response at all)
 * plus the total number of completed requests observed.
 * Exported for unit tests.
 */
export function parseNetworkLog(text: string): {
  failed: TraceFailedRequest[];
  total: number;
} {
  const failed: TraceFailedRequest[] = [];
  let total = 0;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: {
      type?: string;
      snapshot?: {
        request?: { method?: unknown; url?: unknown };
        response?: { status?: unknown; statusText?: unknown } | null;
        error?: unknown;
        _resourceType?: unknown;
      };
    };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== 'resource-snapshot' || !event.snapshot) continue;

    const snap = event.snapshot;
    total += 1;

    const req = snap.request ?? {};
    const resp = snap.response ?? undefined;
    const status = typeof resp?.status === 'number' ? resp.status : undefined;
    const errRaw = snap.error;
    const errorText =
      typeof errRaw === 'string'
        ? errRaw
        : errRaw && typeof errRaw === 'object' && typeof (errRaw as { message?: unknown }).message === 'string'
          ? (errRaw as { message: string }).message
          : undefined;

    const isFailure = errorText !== undefined || status === undefined || status >= 400 || status === 0;
    if (!isFailure) continue;
    if (failed.length >= MAX_FAILED_REQUESTS) continue; // still counted in `total`

    failed.push({
      method: typeof req.method === 'string' ? req.method : 'GET',
      url: typeof req.url === 'string' ? req.url : '',
      status: status !== undefined && status !== 0 ? status : undefined,
      statusText: typeof resp?.statusText === 'string' ? resp.statusText : undefined,
      resourceType: typeof snap._resourceType === 'string' ? snap._resourceType : undefined,
      errorText: status === 0 || status === undefined ? (errorText ?? 'request failed') : errorText,
    });
  }

  return { failed, total };
}

/**
 * Read a trace.zip produced by Playwright and extract the failure
 * context: error, failed action, action log, DOM snapshot and the
 * error-context attachment. Returns null when the file is
 * missing/unreadable — callers degrade to a hint instead of failing.
 */
export async function readFailureTrace(tracePath: string): Promise<FailureTraceContext | null> {
  let buf: Buffer;
  try {
    buf = await readFile(tracePath);
  } catch {
    return null;
  }

  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buf);
  } catch {
    return {
      error: 'The trace archive could not be read.',
      actionLog: [],
      consoleMessages: [],
      failedRequests: [],
      networkTotal: 0,
      warnings: [`Failed to parse ${normalizePath(tracePath)} as a ZIP archive.`],
    };
  }

  const traceLines: string[] = [];
  for (const [name, data] of entries) {
    if (name.endsWith('.trace')) {
      traceLines.push(...decodeEntryText(data).split(/\r?\n/));
    }
  }

  if (traceLines.length === 0) {
    return {
      error: 'The trace archive contained no event log.',
      actionLog: [],
      consoleMessages: [],
      failedRequests: [],
      networkTotal: 0,
      warnings: [`No *.trace entries found in ${normalizePath(tracePath)}.`],
    };
  }

  const context = analyzeTraceEvents(
    traceLines,
    (hash) => loadSnapshotSync(entries, hash),
    (name) => loadFromZip(entries, [name, `attachments/${name}`]),
  );

  // Network diagnostics: merge the *.network resource logs.
  let networkTotal = 0;
  const failedRequests: TraceFailedRequest[] = [];
  for (const [name, data] of entries) {
    if (!name.endsWith('.network')) continue;
    const parsed = parseNetworkLog(decodeEntryText(data));
    networkTotal += parsed.total;
    for (const req of parsed.failed) {
      if (failedRequests.length < MAX_FAILED_REQUESTS) failedRequests.push(req);
    }
  }
  context.failedRequests = failedRequests;
  context.networkTotal = networkTotal;

  return context;
}
