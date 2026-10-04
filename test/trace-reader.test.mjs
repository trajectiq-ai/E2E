import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readZipEntries, analyzeTraceEvents, readFailureTrace, parseNetworkLog } from '../dist/utils/trace-reader.js';

/* ---- minimal ZIP writer (store or deflate) for fixtures ---- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

const TRACE_LINES = [
  JSON.stringify({ type: 'context-created' }),
  JSON.stringify({ type: 'action', api: 'goto', params: { url: 'http://localhost:3000/login' }, startTime: 1000, snapshot: 'h1' }),
  JSON.stringify({ type: 'after', snapshot: 'h1' }),
  JSON.stringify({ type: 'action', api: 'fill', params: { selector: '#email', value: 'a@b.c' }, startTime: 1500, snapshot: 'h2' }),
  JSON.stringify({ type: 'after', snapshot: 'h2' }),
  JSON.stringify({ type: 'action', api: 'click', params: { selector: '#submit-btn' }, startTime: 2000, snapshot: 'h3' }),
  JSON.stringify({ type: 'error', error: { message: 'Timeout 30000ms exceeded.' }, startTime: 2100, snapshot: 'h3' }),
].join('\n');

const SNAPSHOT_HTML =
  '<html><body><div id="form-wrap"><form class="login-form"><input id="email" name="email">' +
  '<button id="submit-btn" class="btn primary">Sign in</button></form></div></body></html>';

test('readZipEntries reads stored and deflated entries', () => {
  const zip = buildZip([
    { name: 'a.txt', data: Buffer.from('hello world'), deflate: false },
    { name: 'nested/b.bin', data: Buffer.from('x'.repeat(5000)), deflate: true },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.get('a.txt').toString('utf8'), 'hello world');
  assert.equal(entries.get('nested/b.bin').length, 5000);
});

test('readZipEntries rejects non-zip input', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all, definitely not')));
});

test('analyzeTraceEvents extracts error, failed action, log and DOM snapshot', () => {
  const snapshots = { h3: SNAPSHOT_HTML };
  const ctx = analyzeTraceEvents(TRACE_LINES, (hash) => snapshots[hash]);

  assert.match(ctx.error, /Timeout 30000ms exceeded/);
  assert.equal(ctx.action.api, 'click');
  assert.equal(ctx.action.selector, '#submit-btn');
  assert.equal(ctx.atMs, 1100);
  assert.deepEqual(ctx.warnings, []);

  assert.equal(ctx.actionLog.length, 3);
  assert.equal(ctx.actionLog[0].api, 'goto');
  assert.equal(ctx.actionLog[1].api, 'fill');
  assert.equal(ctx.actionLog[2].api, 'click');
  assert.equal(ctx.actionLog[2].failed, true);

  assert.ok(ctx.snapshotHtml.includes('submit-btn'));
  // Snippet is a window around the failing element (parent container).
  assert.ok(ctx.snippet.includes('form-wrap'));
  assert.ok(ctx.snippet.includes('submit-btn'));
});

test('analyzeTraceEvents warns instead of throwing on partial traces', () => {
  const noSnapshot = analyzeTraceEvents(
    [JSON.stringify({ type: 'action', api: 'goto', params: { url: '/' }, startTime: 1 }),
     JSON.stringify({ type: 'error', error: 'boom' })].join('\n'),
    () => undefined,
  );
  assert.match(noSnapshot.error, /boom/);
  assert.ok(noSnapshot.warnings.some((w) => /No DOM snapshot/.test(w)));

  const empty = analyzeTraceEvents('', () => undefined);
  assert.ok(empty.warnings.length > 0);
  assert.equal(empty.actionLog.length, 0);

  const brokenLines = analyzeTraceEvents(['{not json', '{"type":"action","api":"goto","startTime":5}'], () => undefined);
  assert.equal(brokenLines.actionLog.length, 1);
});

test('analyzeTraceEvents handles the real Playwright 1.63 schema', () => {
  const lines = [
    { version: 9, type: 'context-options', monotonicTime: 758.959 },
    { type: 'before', callId: 'hook@1', class: 'Test', method: 'hook', title: 'Before Hooks', params: {}, startTime: 778 },
    { type: 'after', callId: 'hook@1', endTime: 954 },
    { type: 'before', callId: 'pw:api@43', class: 'Test', method: 'pw:api', title: 'Navigate', params: { url: '/checkout' }, startTime: 955 },
    { type: 'before', callId: 'call@11', class: 'Frame', method: 'goto', params: { url: '/checkout' }, startTime: 956 },
    { type: 'frame-snapshot', callId: 'call@11', phase: 'before', snapshot: { html: ['HTML', {}, ['BODY', {}, ['DIV', { id: 'root' }, ['BUTTON', { 'data-testid': 'buy' }, 'Buy now']]]] } },
    { type: 'after', callId: 'call@11', endTime: 1000, error: { message: 'net::ERR_CONNECTION_REFUSED' } },
    { type: 'after', callId: 'pw:api@43', endTime: 1005, error: { message: 'page.goto: net::ERR_CONNECTION_REFUSED' } },
    { type: 'error', message: 'page.goto: net::ERR_CONNECTION_REFUSED' },
    { type: 'after', callId: 'attach@1', endTime: 1064, attachments: [{ name: 'error-context', contentType: 'text/markdown', file: 'attachments/abc' }] },
  ].map((event) => JSON.stringify(event)).join('\n');

  const ctx = analyzeTraceEvents(
    lines,
    () => undefined,
    (name) => (name === 'attachments/abc' ? '- button "Buy now"' : undefined),
  );

  assert.match(ctx.error, /ERR_CONNECTION_REFUSED/);
  assert.ok(ctx.action, 'failed action captured');
  assert.match(ctx.action.api, /goto/);
  assert.ok(ctx.atMs > 0);

  // Inline frame-snapshot DOM tree rendered back to HTML.
  assert.ok(ctx.snapshotHtml.includes('<button data-testid="buy">Buy now</button>'), ctx.snapshotHtml);
  assert.ok(ctx.warnings.length === 0, JSON.stringify(ctx.warnings));
  assert.equal(ctx.errorContext, '- button "Buy now"');

  // Hooks/fixtures stay out; failing steps are marked failed.
  const apis = ctx.actionLog.map((entry) => `${entry.api}:${entry.failed}`);
  assert.ok(apis.some((a) => a.includes('goto:true')), JSON.stringify(apis));
  assert.ok(apis.some((a) => a.startsWith('Navigate:true')), JSON.stringify(apis));
  assert.ok(!apis.some((a) => a.includes('Hooks')), JSON.stringify(apis));
});

test('readFailureTrace opens a real trace.zip and returns null for missing files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pw-trace-'));
  try {
    const tracePath = path.join(dir, 'trace.zip');
    await writeFile(
      tracePath,
      buildZip([
        { name: 'trace.trace', data: Buffer.from(TRACE_LINES, 'utf8'), deflate: true },
        { name: 'resources/h1', data: gzipSync(Buffer.from('<html><body>one</body></html>')), deflate: true },
        { name: 'resources/h2', data: gzipSync(Buffer.from('<html><body>two</body></html>')), deflate: true },
        { name: 'resources/h3', data: gzipSync(Buffer.from(SNAPSHOT_HTML)), deflate: true },
      ]),
    );

    const ctx = await readFailureTrace(tracePath);
    assert.match(ctx.error, /Timeout 30000ms/);
    assert.equal(ctx.action.api, 'click');
    assert.ok(ctx.snapshotHtml.includes('form-wrap'));
    assert.deepEqual(ctx.warnings, []);

    assert.equal(await readFailureTrace(path.join(dir, 'missing.zip')), null);

    const corruptPath = path.join(dir, 'corrupt.zip');
    await writeFile(corruptPath, Buffer.from('garbage bytes'));
    const corrupt = await readFailureTrace(corruptPath);
    assert.ok(corrupt !== null);
    assert.ok(corrupt.warnings.some((w) => /ZIP/.test(w)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---- network diagnostics (*.network resource-snapshots) ---- */

const NETWORK_LINES = [
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'http://app.local/' },
      response: { status: 200, statusText: 'OK' },
      _resourceType: 'document',
    },
  }),
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'http://app.local/missing.json' },
      response: { status: 404, statusText: 'Not Found' },
      _resourceType: 'fetch',
    },
  }),
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'POST', url: 'http://app.local/api/save' },
      response: { status: 500, statusText: 'Internal Server Error' },
      _resourceType: 'xhr',
    },
  }),
  JSON.stringify({
    type: 'resource-snapshot',
    snapshot: {
      request: { method: 'GET', url: 'http://app.local/dead' },
      error: { message: 'net::ERR_CONNECTION_REFUSED' },
      _resourceType: 'fetch',
    },
  }),
  'not-json-line',
  JSON.stringify({ type: 'context-options' }),
].join('\n');

test('parseNetworkLog extracts failed requests and counts totals', () => {
  const { failed, total } = parseNetworkLog(NETWORK_LINES);
  assert.equal(total, 4, 'four resource snapshots counted');
  assert.equal(failed.length, 3);

  const notFound = failed.find((r) => r.url.includes('missing.json'));
  assert.ok(notFound);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.statusText, 'Not Found');
  assert.equal(notFound.method, 'GET');
  assert.equal(notFound.resourceType, 'fetch');

  const serverError = failed.find((r) => r.status === 500);
  assert.ok(serverError);
  assert.equal(serverError.method, 'POST');

  const refused = failed.find((r) => r.url.endsWith('/dead'));
  assert.ok(refused, 'response-less request flagged as failed');
  assert.equal(refused.status, undefined);
  assert.match(refused.errorText, /ERR_CONNECTION_REFUSED/);

  assert.ok(!failed.some((r) => r.url === 'http://app.local/'), 'healthy 200 not flagged');
});

test('parseNetworkLog caps failures but keeps the total count', () => {
  const lines = Array.from({ length: 12 }, (_, i) =>
    JSON.stringify({
      type: 'resource-snapshot',
      snapshot: {
        request: { method: 'GET', url: `http://app.local/broken-${i}` },
        response: { status: 404, statusText: 'Not Found' },
      },
    }),
  ).join('\n');
  const { failed, total } = parseNetworkLog(lines);
  assert.equal(failed.length, 8);
  assert.equal(total, 12);
});

test('parseNetworkLog tolerates empty and malformed input', () => {
  assert.deepEqual(parseNetworkLog(''), { failed: [], total: 0 });
  assert.deepEqual(parseNetworkLog('garbage\n{"type":"other"}'), { failed: [], total: 0 });
});

/* ---- console diagnostics (type === "console" events) ---- */

test('analyzeTraceEvents captures console errors and warnings', () => {
  const lines = [
    { type: 'context-options', version: 9 },
    {
      type: 'console',
      messageType: 'error',
      text: 'fixture-console-error: cart service unreachable',
      location: { url: 'http://app.local/', lineNumber: 4 },
      time: 10,
    },
    { type: 'console', messageType: 'warning', text: 'slow network detected', time: 20 },
    { type: 'console', messageType: 'log', text: 'noise that should be ignored', time: 30 },
    { type: 'error', message: 'expect(received).toBeVisible()' },
  ].map((event) => JSON.stringify(event)).join('\n');

  const ctx = analyzeTraceEvents(lines, () => undefined);
  assert.equal(ctx.consoleMessages.length, 2, 'errors and warnings only');

  const [first, second] = ctx.consoleMessages;
  assert.equal(first.type, 'error');
  assert.match(first.text, /fixture-console-error/);
  assert.equal(first.location, 'http://app.local/:4');
  assert.equal(second.type, 'warning');
  assert.equal(second.location, undefined);
  assert.match(ctx.error, /toBeVisible/);
  assert.deepEqual(ctx.failedRequests, []);
  assert.equal(ctx.networkTotal, 0);
});

test('readFailureTrace merges network and console diagnostics from the archive', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pw-trace-net-'));
  try {
    const tracePath = path.join(dir, 'trace.zip');
    const traceLines = [
      { type: 'before', callId: 'call@1', class: 'Frame', method: 'goto', params: { url: '/' }, startTime: 100 },
      { type: 'console', messageType: 'error', text: 'boom from page', time: 150 },
      { type: 'after', callId: 'call@1', endTime: 200, error: { message: 'Timeout 30000ms exceeded' } },
      { type: 'error', message: 'Timeout 30000ms exceeded' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n');

    await writeFile(
      tracePath,
      buildZip([
        { name: 'test.trace', data: Buffer.from(traceLines, 'utf8'), deflate: true },
        { name: '1-trace.network', data: Buffer.from(NETWORK_LINES, 'utf8'), deflate: true },
        { name: '0-trace.network', data: Buffer.from('', 'utf8'), deflate: false },
      ]),
    );

    const ctx = await readFailureTrace(tracePath);
    assert.match(ctx.error, /Timeout/);
    assert.equal(ctx.networkTotal, 4);
    assert.equal(ctx.failedRequests.length, 3);
    assert.ok(ctx.failedRequests.some((r) => r.status === 404));
    assert.equal(ctx.consoleMessages.length, 1);
    assert.match(ctx.consoleMessages[0].text, /boom from page/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
