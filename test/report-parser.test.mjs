import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReportJson,
  extractJsonFromText,
  classifyFailure,
  diagnoseOutput,
  firstMeaningfulLine,
  extractTestTitles,
  parseProjectNames,
  stripAnsi,
} from '../dist/utils/report-parser.js';

/** A representative Playwright JSON report. */
const sampleReport = {
  config: {
    rootDir: '/repo/app',
    configFile: '/repo/app/playwright.config.ts',
    projects: [{ name: 'chromium' }, { name: 'firefox' }],
  },
  stats: { expected: 2, unexpected: 2, flaky: 1, skipped: 1, duration: 12_345 },
  suites: [
    {
      title: 'auth.spec.ts',
      file: '/repo/app/tests/auth.spec.ts',
      line: 1,
      suites: [
        {
          title: 'login',
          specs: [
            {
              title: 'shows an error on bad password',
              file: '/repo/app/tests/auth.spec.ts',
              line: 10,
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    {
                      status: 'failed',
                      retry: 0,
                      duration: 800,
                      error: {
                        message: 'expect(received).toBe(expected)\nExpected: 200\nReceived: 401',
                        stack: 'Error: boom\n    at tests/auth.spec.ts:14:5',
                      },
                    },
                    { status: 'passed', retry: 1, duration: 640 },
                  ],
                },
              ],
            },
            {
              title: 'redirects to dashboard',
              file: '/repo/app/tests/auth.spec.ts',
              line: 22,
              tests: [
                {
                  projectName: 'chromium',
                  results: [
                    {
                      status: 'timedOut',
                      retry: 0,
                      duration: 30_000,
                      error: { message: 'Timeout 30000ms exceeded.' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: 'checkout.spec.ts',
      file: '/repo/app/tests/checkout.spec.ts',
      specs: [
        {
          title: 'pays with card',
          file: '/repo/app/tests/checkout.spec.ts',
          line: 5,
          tests: [
            {
              projectName: 'firefox',
              results: [
                {
                  status: 'failed',
                  retry: 0,
                  duration: 400,
                  error: {
                    message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000',
                    expected: 200,
                    actual: 503,
                  },
                },
              ],
            },
          ],
        },
        {
          title: 'empty cart',
          file: '/repo/app/tests/checkout.spec.ts',
          line: 9,
          tests: [{ projectName: 'chromium', results: [{ status: 'skipped' }] }],
        },
      ],
    },
  ],
};

test('parseReportJson extracts stats, failures and tests from sample JSON', () => {
  const parsed = parseReportJson(JSON.stringify(sampleReport), '/repo/app');

  assert.deepEqual(parsed.stats, {
    expected: 2,
    unexpected: 2,
    flaky: 1,
    skipped: 1,
    duration: 12_345,
  });
  assert.equal(parsed.specCount, 4);
  assert.deepEqual(parsed.projects.sort(), ['chromium', 'firefox']);
  assert.equal(parsed.configPath, 'playwright.config.ts');
  assert.equal(parsed.parseError, undefined);

  // The flaky (failed then passed) test is NOT a failure.
  assert.equal(parsed.failures.length, 2);
  const titles = parsed.failures.map((f) => f.title);
  assert.ok(titles.includes('auth.spec.ts › login › redirects to dashboard'));
  assert.ok(titles.includes('checkout.spec.ts › pays with card'));
  assert.ok(!titles.some((t) => t.includes('shows an error')));

  const timeout = parsed.failures.find((f) => f.status === 'timedOut');
  assert.equal(timeout.failureKind, 'timeout');
  assert.equal(timeout.file, 'tests/auth.spec.ts');
  assert.equal(timeout.line, 22);

  const deadServer = parsed.failures.find((f) => f.project === 'firefox');
  assert.equal(deadServer.failureKind, 'server-unreachable');
  assert.equal(deadServer.expected, '200');
  assert.equal(deadServer.actual, '503');
});

test('parseReportJson lists every test case for --list consumption', () => {
  const parsed = parseReportJson(JSON.stringify(sampleReport), '/repo/app');
  assert.equal(parsed.tests.length, 4);
  const first = parsed.tests[0];
  assert.equal(first.file, 'tests/auth.spec.ts');
  assert.equal(first.line, 10);
  assert.equal(first.title, 'auth.spec.ts › login › shows an error on bad password');
  assert.deepEqual(first.projects, ['chromium']);
});

test('parseReportJson computes stats when stats are missing', () => {
  const report = {
    suites: [
      {
        title: 'a.spec.ts',
        file: 'tests/a.spec.ts',
        specs: [
          { title: 'passes', file: 'tests/a.spec.ts', line: 1, tests: [{ projectName: 'chromium', results: [{ status: 'passed', duration: 10 }] }] },
          { title: 'fails', file: 'tests/a.spec.ts', line: 2, tests: [{ projectName: 'chromium', results: [{ status: 'failed', duration: 20 }] }] },
          { title: 'skips', file: 'tests/a.spec.ts', line: 3, tests: [{ projectName: 'chromium', results: [{ status: 'skipped' }] }] },
        ],
      },
    ],
  };
  const parsed = parseReportJson(JSON.stringify(report), '/repo');
  assert.equal(parsed.stats.expected, 1);
  assert.equal(parsed.stats.unexpected, 1);
  assert.equal(parsed.stats.skipped, 1);
  assert.equal(parsed.stats.duration, 30);
  assert.equal(parsed.failures.length, 1);
});

test('parseReportJson surfaces top-level config errors as failures', () => {
  const report = {
    errors: [
      {
        message: 'Error: No tests found.',
        stack: 'Error: No tests found.',
      },
    ],
  };
  const parsed = parseReportJson(JSON.stringify(report), '/repo');
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].title, 'configuration');
  assert.equal(parsed.failures[0].failureKind, 'config');
  assert.equal(parsed.stats.unexpected, 1);
});

test('parseReportJson never throws on garbage', () => {
  const empty = parseReportJson('this is not json', '/repo');
  assert.ok(empty.parseError);
  assert.equal(empty.failures.length, 0);

  const notObject = parseReportJson('[1,2,3]', '/repo');
  assert.ok(notObject.parseError);

  const unrelated = parseReportJson('{"hello":"world"}', '/repo');
  assert.ok(unrelated.parseError);
});

test('parseReportJson honors the maxFailures cap', () => {
  const specs = Array.from({ length: 10 }, (_, i) => ({
    title: `failing ${i}`,
    file: 'tests/x.spec.ts',
    line: i + 1,
    tests: [{ projectName: 'chromium', results: [{ status: 'failed', error: { message: 'nope' } }] }],
  }));
  const report = { suites: [{ title: 'x', specs }] };
  const capped = parseReportJson(JSON.stringify(report), '/repo', 3);
  assert.equal(capped.failures.length, 3);
  assert.equal(capped.failuresTruncated, true);
  const full = parseReportJson(JSON.stringify(report), '/repo', 50);
  assert.equal(full.failures.length, 10);
  assert.equal(full.failuresTruncated, false);
});

test('extractJsonFromText pulls the report out of interleaved logs', () => {
  const text = 'log line 1\n{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":5}}\ntrailing noise';
  const json = extractJsonFromText(text);
  assert.ok(json);
  assert.equal(JSON.parse(json).stats.expected, 1);
  assert.equal(extractJsonFromText('no json here'), null);
});

test('classifyFailure maps messages to failure kinds', () => {
  assert.equal(classifyFailure('Timeout 30000ms exceeded.', 'timedOut'), 'timeout');
  assert.equal(classifyFailure('SyntaxError: Unexpected token', 'failed'), 'syntax');
  assert.equal(classifyFailure('Target page, context or browser has been closed', 'failed'), 'browser-crash');
  assert.equal(classifyFailure('connect ECONNREFUSED 127.0.0.1:3000', 'failed'), 'server-unreachable');
  assert.equal(classifyFailure('expect(received).toBe(expected)', 'failed'), 'assertion');
  assert.equal(classifyFailure('something odd happened', 'failed'), 'unknown');
});

test('diagnoseOutput recognizes every documented edge case', () => {
  const cases = [
    ['Error: ENOSPC: no space left on device, write', 'DISK_FULL'],
    ['SyntaxError: Unexpected token } in /app/tests/a.spec.ts:12', 'SYNTAX_ERROR'],
    ["browserType.launch: Executable doesn't exist at C:\\pw\\chrome.exe", 'NO_PLAYWRIGHT'],
    ['Error: listen ECONNREFUSED 127.0.0.1:3000', 'SERVER_NOT_RUNNING'],
    ['Process from config.webServer was unable to start', 'SERVER_NOT_RUNNING'],
    ['Target page, context or browser has been closed', 'BROWSER_CRASH'],
    ['Timeout 30000ms exceeded while waiting for http://localhost:5173', 'TIMEOUT'],
    ['Cannot find module ./missing-helper', 'SYNTAX_ERROR'],
  ];
  for (const [text, kind] of cases) {
    const diagnosis = diagnoseOutput(text);
    assert.ok(diagnosis, `expected a diagnosis for ${text}`);
    assert.equal(diagnosis.errorKind, kind, `wrong kind for ${text}`);
    assert.ok(diagnosis.hint.length > 10, 'hint must be actionable');
    assert.ok(diagnosis.errorMessage.length > 0);
  }
  assert.equal(diagnoseOutput('all good, 12 tests passed'), null);
  assert.equal(diagnoseOutput(''), null);
});

test('firstMeaningfulLine prefers lines that look like errors', () => {
  const blob = 'Running 1 test using 1 worker\n  1) [chromium] › a.spec.ts:4:1 › x\nError: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:9\n    at foo';
  assert.equal(firstMeaningfulLine(blob), 'Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:9');
  // Falls back to the first content line when nothing looks like an error.
  assert.equal(firstMeaningfulLine('plain intro\nall fine'), 'plain intro');
  assert.equal(firstMeaningfulLine(''), undefined);
});

test('stripAnsi removes color codes', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('extractTestTitles rebuilds describe › test paths', () => {
  const source = [
    "test.describe('checkout', () => {",
    "  test('adds an item', async () => {});",
    '',
    "  test.describe('payments', () => {",
    "    test('accepts visa', async () => {});",
    '  });',
    '});',
    '',
    "test('logs out', async () => {});",
    "test.skip('flaky one', async () => {});",
  ].join('\n');

  const titles = extractTestTitles(source);
  assert.deepEqual(titles.map((t) => t.title), [
    'checkout › adds an item',
    'checkout › payments › accepts visa',
    'logs out',
    'flaky one',
  ]);
  assert.equal(titles[0].line, 2);
  assert.equal(titles[2].line, 9);
  // test.skip is still a test that exists in the file
  const skipped = extractTestTitles("test.skip('flaky one', async () => {});");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].title, 'flaky one');
});

test('parseReportJson records trace attachments and test console output on failures', () => {
  const report = {
    config: { rootDir: '/repo' },
    suites: [
      {
        title: 'a.spec.ts',
        file: 'tests/a.spec.ts',
        specs: [
          {
            title: 'clicks the button',
            file: 'tests/a.spec.ts',
            line: 3,
            tests: [
              {
                projectName: 'chromium',
                results: [
                  {
                    status: 'failed',
                    error: { message: 'Timeout 30000ms exceeded.' },
                    attachments: [
                      { name: 'trace', path: 'test-results/a/trace.zip', contentType: 'application/zip' },
                    ],
                    stdout: ['console says hi', { text: 'second line' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseReportJson(JSON.stringify(report), '/repo');
  const failure = parsed.failures[0];
  assert.equal(parsed.failures.length, 1);
  // Relative attachment paths resolve against the report rootDir.
  assert.equal(failure.tracePath, '/repo/test-results/a/trace.zip');
  assert.match(failure.stdout, /console says hi/);
  assert.match(failure.stdout, /second line/);

  // Absolute attachment paths are kept as-is.
  const absolute = JSON.parse(JSON.stringify(report));
  absolute.suites[0].specs[0].tests[0].results[0].attachments[0].path = 'C:/proj/test-results/t.zip';
  const parsedAbs = parseReportJson(JSON.stringify(absolute), 'C:/proj');
  assert.equal(parsedAbs.failures[0].tracePath, 'C:/proj/test-results/t.zip');

  // No attachments → no tracePath.
  const without = JSON.parse(JSON.stringify(report));
  delete without.suites[0].specs[0].tests[0].results[0].attachments;
  delete without.suites[0].specs[0].tests[0].results[0].stdout;
  const parsedNone = parseReportJson(JSON.stringify(without), '/repo');
  assert.equal(parsedNone.failures[0].tracePath, undefined);
  assert.equal(parsedNone.failures[0].stdout, undefined);
});

test('parseReportJson rebases testDir-relative spec files to the project root', () => {
  // Playwright emits `file` relative to config.rootDir (the testDir), so a
  // project with testDir: './tests' reports 'fail.spec.ts'. Consumers
  // (run-test, diagnose-flaky, next-step suggestions) address files from
  // the project root — the parser must rebase, not pass the bare name on.
  const report = {
    config: { rootDir: '/repo/tests' },
    suites: [
      {
        title: 'fail.spec.ts',
        file: 'fail.spec.ts',
        specs: [
          {
            title: 'checkout fails',
            file: 'fail.spec.ts',
            line: 9,
            tests: [
              { projectName: 'chromium', results: [{ status: 'failed', error: { message: 'boom' } }] },
            ],
          },
        ],
      },
    ],
  };
  const parsed = parseReportJson(JSON.stringify(report), '/repo');
  assert.equal(parsed.failures[0].file, 'tests/fail.spec.ts');
  assert.equal(parsed.failures[0].line, 9);
  assert.equal(parsed.tests[0].file, 'tests/fail.spec.ts');
});

test('parseProjectNames finds configured project names', () => {
  const source = `
    export default defineConfig({
      projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Firefox'] } },
      ],
    });
  `;
  assert.deepEqual(parseProjectNames(source), ['chromium', 'firefox']);
  assert.deepEqual(parseProjectNames('export default {}'), []);
});
