/**
 * The hosted (Vercel) endpoint and the local stdio server must expose the
 * same protocol. This spins the real Node adapter over `node:http` — the same
 * `handleNodeRequest` the deployed function calls — and drives it with the
 * JSON-RPC messages a Streamable HTTP client sends, so a broken bridge fails
 * here rather than in ChatGPT. With a token the bridge serves every tool;
 * without one it serves only the read-only ones, so both modes run here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMcpHttpHandler, handleNodeRequest } from '../dist/http.js';

const TOKEN = 'bridge-test-token';
const handler = createMcpHttpHandler({ token: TOKEN, allowedHosts: [] });
const openHandler = createMcpHttpHandler({ token: '', allowedHosts: [] });
let server;
let openServer;
let base;
let openBase;

async function listen(h) {
  const srv = http.createServer((req, res) => {
    void handleNodeRequest(h, req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

before(async () => {
  ({ srv: server, url: base } = await listen(handler));
  ({ srv: openServer, url: openBase } = await listen(openHandler));
});

after(async () => {
  await handler.close().catch(() => undefined);
  await openHandler.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => openServer.close(resolve));
});

/**
 * Streamable HTTP allows the server to answer a POST either with one JSON
 * body or with an SSE stream carrying the same message. Both are legal, so
 * the assertions below must not depend on which one the SDK picks.
 */
function firstMessage(text, contentType) {
  if (!text) return null;
  if (!contentType.includes('text/event-stream')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

async function post(
  body,
  { accept = 'application/json, text/event-stream', url = base, token = TOKEN } = {},
) {
  const headers = { 'content-type': 'application/json', accept };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = firstMessage(text, res.headers.get('content-type') ?? '');
  return { res, text, json };
}

test('initialize handshake answers with server info', async () => {
  const { res, json } = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bridge-test', version: '1.0.0' },
    },
  });
  assert.equal(res.status, 200);
  assert.ok(json, 'initialize must answer JSON');
  assert.equal(json.id, 1);
  assert.ok(json.result, `expected a result, got ${JSON.stringify(json.error)}`);
  assert.equal(json.result.serverInfo.name, 'playwright-e2e-mcp');
  assert.ok(json.result.protocolVersion);
  assert.match(res.headers.get('content-type') ?? '', /(?:application\/json|text\/event-stream)/);
});

test('tools/list exposes all eleven tools', async () => {
  const { res, json } = await post({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  assert.equal(res.status, 200);
  assert.ok(json?.result, `expected a result, got ${JSON.stringify(json?.error)}`);
  const names = json.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'analyze-history',
    'compare-visual-state',
    'diagnose-flaky',
    'generate-e2e-test',
    'get-failure',
    'get-run-status',
    'inspect-page',
    'list-tests',
    'run-test',
    'suggest-fix',
    'validate-selector',
  ]);
  for (const tool of json.result.tools) {
    assert.ok(tool.title, `${tool.name} needs a title`);
    assert.ok(tool.description, `${tool.name} needs a description`);
  }
});

test('initialized notification is acknowledged', async () => {
  const { res, text } = await post({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  assert.ok(res.status === 202 || res.status === 200, `unexpected ${res.status}: ${text}`);
});

test('tools/call round-trips through the adapter', async () => {
  const { res, json } = await post({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list-tests', arguments: {} },
  });
  assert.equal(res.status, 200);
  assert.ok(json?.result, `expected a result, got ${JSON.stringify(json?.error)}`);
  assert.notEqual(json.result.isError, true, 'list_tests should not fail in this repo');
  const text = json.result.content?.[0]?.text;
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0, 'tool returned empty text');
});

test('GET without a session is rejected, not hung', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'GET',
    headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` },
  });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  await res.body?.cancel();
});

test('an unparsable body is a 4xx, never a crash', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: 'not json',
  });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  await res.text();
});

test('a missing or wrong token is a 401 when a token is configured', async () => {
  for (const token of ['', 'wrong-token']) {
    const { res } = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, { token });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
  }
});

test('without a token only read-only tools are served', async () => {
  const { res, json } = await post(
    { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} },
    { url: openBase, token: '' },
  );
  assert.equal(res.status, 200);
  const names = json.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['analyze-history', 'get-failure', 'list-tests']);
});

test('the Host allowlist rejects unexpected hosts', async () => {
  const strict = createMcpHttpHandler({ token: TOKEN, allowedHosts: ['example.test'] });
  try {
    const res = await strict.fetch(
      new Request('http://evil.test/mcp', {
        method: 'POST',
        headers: {
          host: 'evil.test',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }),
      }),
    );
    assert.equal(res.status, 403);
  } finally {
    await strict.close().catch(() => undefined);
  }
});
