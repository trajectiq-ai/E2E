import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSEMBLED_MARKER } from '../scripts/assemble-release.mjs';
import { existingRelease, fillDraft, publicationPlan, publishDraft } from '../scripts/publish-release.mjs';

/**
 * A stand-in `gh`: it records every call, answers `release view` from a state
 * object the test controls, and — like the real release — serves back whatever
 * was uploaded, unless the test wants a mismatch.
 */
function fakeGh({ release = null, viewResult = null, tamper = null, drop = null, extra = null } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const [group, action] = args;
    if (group === 'release' && action === 'view') {
      if (viewResult) return viewResult;
      if (!release) return { status: 1, stdout: '', stderr: `release not found: ${args[2]}` };
      const wants = args[args.indexOf('--json') + 1] ?? '';
      const json = {};
      for (const key of wants.split(',')) if (key in release) json[key] = release[key];
      return { status: 0, stdout: JSON.stringify(json), stderr: '' };
    }
    if (group === 'release' && action === 'download') {
      const dir = args[args.indexOf('-D') + 1];
      for (const file of uploads.get(args[2]) ?? []) {
        const name = path.basename(file);
        if (name === drop) continue;
        const bytes = name === tamper ? Buffer.from('something else entirely\n') : readFileSync(file);
        writeFileSync(path.join(dir, name), bytes);
      }
      if (extra) writeFileSync(path.join(dir, extra), 'not part of the release\n');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (group === 'release' && action === 'upload') {
      const tag = args[2];
      const files = args.slice(3).filter((arg) => !arg.startsWith('--'));
      uploads.set(tag, [...(uploads.get(tag) ?? []), ...files]);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const uploads = new Map();
  return { run, calls, uploads, names: () => calls.map((args) => args.slice(0, 3).join(' ')) };
}

/** An assembled release on disk: an asset directory that looks like the real one. */
function assets() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'publish-release-test-'));
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const files = ['playwright-e2e-mcp-0.2.3.mcpb', 'playwright-e2e-mcp-0.2.3.mcpb.sha256', 'SHA256SUMS.txt'];
  for (const name of files) writeFileSync(path.join(dir, 'assets', name), `${name} bytes\n`);
  writeFileSync(path.join(dir, 'RELEASE_TITLE.txt'), 'v0.2.3 — the tag assembles its own release\n');
  writeFileSync(path.join(dir, 'RELEASE_BODY.md'), `${ASSEMBLED_MARKER}\n\n## What is in it\n`);
  return {
    dir,
    assetsDir: path.join(dir, 'assets'),
    downloadDir: path.join(dir, 'downloaded'),
    title: readFileSync(path.join(dir, 'RELEASE_TITLE.txt'), 'utf8').trim(),
    body: path.join(dir, 'RELEASE_BODY.md'),
    files,
  };
}

const tag = 'v0.2.3';

test('an existing release is only touched when this workflow assembled it, and only while it is a draft', () => {
  assert.deepEqual(publicationPlan({ tag, existing: null }).action, 'create');
  assert.deepEqual(publicationPlan({ tag, existing: { isDraft: true, body: `${ASSEMBLED_MARKER}\nnotes` } }).action, 'refresh');

  assert.throws(
    () => publicationPlan({ tag, existing: { isDraft: true, body: '## What is in it\n\nhand-written notes' } }),
    /was not assembled by this workflow/,
  );
  assert.throws(() => publicationPlan({ tag, existing: { isDraft: true, body: '' } }), /was not assembled by this workflow/);
  assert.throws(
    () => publicationPlan({ tag, existing: { isDraft: false, body: `${ASSEMBLED_MARKER}\nnotes` } }),
    /already published.*bump the version/s,
  );
});

test('a release that does not exist is reported as absent, a failing lookup is not', () => {
  assert.equal(existingRelease(tag, fakeGh().run), null);
  assert.deepEqual(
    existingRelease(tag, fakeGh({ release: { isDraft: true, body: ASSEMBLED_MARKER } }).run),
    { isDraft: true, body: ASSEMBLED_MARKER },
  );
  const offline = () => ({ status: 1, stdout: '', stderr: 'error connecting to api.github.com' });
  assert.throws(() => existingRelease(tag, offline), /could not read the release for v0\.2\.3/);
});

test('a draft is created, filled, and read back before anything is published', () => {
  const f = assets();
  const gh = fakeGh();
  try {
    const receipt = fillDraft({
      tag,
      assetsDir: f.assetsDir,
      title: f.title,
      body: f.body,
      downloadDir: f.downloadDir,
      run: gh.run,
    });

    assert.equal(receipt.action, 'create');
    assert.deepEqual(receipt.files, [...f.files].sort());
    assert.equal(gh.names()[0], 'release view v0.2.3');
    const create = gh.calls.find((args) => args[1] === 'create');
    assert.ok(create.includes('--draft'), 'the release exists as a draft while it is filled');
    assert.ok(create.includes('--verify-tag'), 'and the tag has to exist, so a typo cannot create one');
    assert.equal(create[create.indexOf('--title') + 1], f.title);
    assert.ok(!gh.names().some((name) => name.includes('--draft=false')), 'filling never publishes');
    for (const name of f.files) {
      assert.equal(readFileSync(path.join(f.downloadDir, name), 'utf8'), readFileSync(path.join(f.assetsDir, name), 'utf8'));
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('re-running over its own draft refreshes it instead of creating a second release', () => {
  const f = assets();
  const gh = fakeGh({ release: { isDraft: true, body: `${ASSEMBLED_MARKER}\n\n## What is in it\n` } });
  try {
    const receipt = fillDraft({ tag, assetsDir: f.assetsDir, title: f.title, body: f.body, downloadDir: f.downloadDir, run: gh.run });
    assert.equal(receipt.action, 'refresh');
    assert.equal(gh.calls.filter((args) => args[1] === 'create').length, 0);
    const edit = gh.calls.find((args) => args[1] === 'edit');
    assert.equal(edit[edit.indexOf('--notes-file') + 1], f.body);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a draft that is not ours is left alone', () => {
  const f = assets();
  const gh = fakeGh({ release: { isDraft: true, body: 'someone else wrote these notes' } });
  try {
    assert.throws(
      () => fillDraft({ tag, assetsDir: f.assetsDir, title: f.title, body: f.body, downloadDir: f.downloadDir, run: gh.run }),
      /was not assembled by this workflow/,
    );
    assert.equal(gh.calls.filter((args) => args[1] !== 'view').length, 0, 'nothing is written');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an already published release is never rewritten', () => {
  const f = assets();
  const gh = fakeGh({ release: { isDraft: false, body: ASSEMBLED_MARKER } });
  try {
    assert.throws(
      () => fillDraft({ tag, assetsDir: f.assetsDir, title: f.title, body: f.body, downloadDir: f.downloadDir, run: gh.run }),
      /already published/,
    );
    assert.equal(gh.calls.filter((args) => args[1] !== 'view').length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an asset that does not come back the same stops the draft', () => {
  const cases = [
    { tamper: 'playwright-e2e-mcp-0.2.3.mcpb', expected: /differs from what was uploaded/ },
    { drop: 'SHA256SUMS.txt', expected: /SHA256SUMS\.txt: not on the release/ },
    { extra: 'unexpected-extra.mcpb', expected: /unexpected-extra\.mcpb: on the release but not in/ },
  ];
  for (const { expected, ...fault } of cases) {
    const f = assets();
    const gh = fakeGh(fault);
    try {
      assert.throws(
        () => fillDraft({ tag, assetsDir: f.assetsDir, title: f.title, body: f.body, downloadDir: f.downloadDir, run: gh.run }),
        expected,
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test('a release without a SHA256SUMS.txt is not published', () => {
  const f = assets();
  const gh = fakeGh();
  try {
    rmSync(path.join(f.assetsDir, 'SHA256SUMS.txt'));
    assert.throws(
      () => fillDraft({ tag, assetsDir: f.assetsDir, title: f.title, body: f.body, downloadDir: f.downloadDir, run: gh.run }),
      /no SHA256SUMS\.txt/,
    );
    assert.equal(gh.calls.length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('publishing flips the draft and reports what went out', () => {
  const draft = { isDraft: true, body: `${ASSEMBLED_MARKER}\nnotes` };
  const published = {
    isDraft: false,
    url: 'https://github.com/trajectiq-ai/E2E/releases/tag/v0.2.3',
    assets: [{ name: 'playwright-e2e-mcp-0.2.3.mcpb', size: 3_506_330 }],
  };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[1] === 'view') return { status: 0, stdout: JSON.stringify(args.includes('isDraft,assets,url') ? published : draft), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const receipt = publishDraft({ tag, run });
  assert.equal(receipt.url, published.url);
  assert.deepEqual(receipt.assets, published.assets);
  const edit = calls.find((args) => args[1] === 'edit');
  assert.ok(edit.includes('--draft=false'));
  assert.ok(edit.includes('--latest'));
});

test('publishing refuses when there is no draft of ours to publish', () => {
  const noRelease = fakeGh();
  assert.throws(() => publishDraft({ tag, run: noRelease.run }), /no draft of ours to publish/);

  const published = fakeGh({ release: { isDraft: false, body: ASSEMBLED_MARKER } });
  assert.throws(() => publishDraft({ tag, run: published.run }), /already published/);

  // GitHub can answer that the release is still a draft after the edit; a green
  // run must not stand in for a publish.
  const stubborn = (args) =>
    args[1] === 'view'
      ? { status: 0, stdout: JSON.stringify({ isDraft: true, body: ASSEMBLED_MARKER }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  assert.throws(() => publishDraft({ tag, run: stubborn }), /still a draft after --draft=false/);
});

test('a write the token is not allowed to make says which setting to change', () => {
  const denied = () => ({ status: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration' });
  assert.throws(
    () => existingRelease(tag, () => ({ status: 1, stdout: '', stderr: 'Resource not accessible by integration' })),
    /Settings -> Actions -> General -> Workflow permissions/,
  );
  const f = assets();
  const run = (args) => (args[1] === 'view' ? { status: 1, stdout: '', stderr: 'release not found: v0.2.3' } : denied());
  try {
    assert.throws(
      () => fillDraft({ tag, assetsDir: f.assetsDir, title: f.title, body: f.body, downloadDir: f.downloadDir, run }),
      /Workflow permissions/,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
