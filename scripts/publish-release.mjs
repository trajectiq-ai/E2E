#!/usr/bin/env node
/**
 * Put an assembled release on GitHub — as a draft first, published only once
 * its own assets have been read back and compared.
 *
 * The hand-made release had a fixed order nobody could check: upload, publish,
 * then hope. Here the release exists as a **draft** while it is filled, every
 * asset is downloaded again and compared with the local copy byte for byte, and
 * `--publish` is a separate call made after `verify-release` has re-derived the
 * whole thing from the tag. A release therefore never becomes public with an
 * asset that was truncated, stale, or never uploaded.
 *
 * The draft is also the safe place to re-run: a failed run leaves a draft, and
 * this refreshes it in place. It refuses two things by name — a release it did
 * not assemble (someone's hand-written notes are not overwritten) and a
 * published one (a release that is out is a fact, not a draft to edit).
 *
 * Usage:
 *   node scripts/publish-release.mjs --tag v0.2.3 --assets dist-release/assets \
 *     --title-file dist-release/RELEASE_TITLE.txt --body-file dist-release/RELEASE_BODY.md \
 *     --download dist-release/downloaded
 *   node scripts/publish-release.mjs --tag v0.2.3 --publish
 *
 * Needs `GH_TOKEN` with `contents: write`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSEMBLED_MARKER } from './assemble-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The repository setting that a refused write points at. */
const PERMISSION_HINT =
  'set Settings -> Actions -> General -> Workflow permissions to "Read and write", then re-run this workflow';

/** Run `gh`, returning its result rather than throwing: deciding what a
 * failure means is this script's job, and that makes it testable. */
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`could not run gh: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: `${result.stdout ?? ''}`, stderr: `${result.stderr ?? ''}` };
}

/** The setting to change when GitHub refused the write rather than the request. */
export function permissionHint(detail) {
  return /Resource not accessible|not accessible by integration|HTTP 403/i.test(detail) ? ` — ${PERMISSION_HINT}` : '';
}

/** A failed command is a failed release: say which one, and what it printed. */
function ok(result, args) {
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.status})${detail ? `: ${detail}` : ''}${permissionHint(detail)}`,
    );
  }
  return result;
}

/**
 * What to do about a release already using this tag.
 *
 * A release whose body carries the marker is this workflow's own draft, and
 * re-running is the normal way to recover from a failure. Anything else is a
 * human's release: it is never overwritten, and a published one is never
 * edited, because either would silently replace something people may have
 * downloaded and pinned.
 */
export function publicationPlan({ tag, existing, marker = ASSEMBLED_MARKER }) {
  if (!existing) return { action: 'create', detail: `no release uses ${tag} yet` };
  if (!`${existing.body ?? ''}`.includes(marker)) {
    throw new Error(
      `a release for ${tag} already exists and was not assembled by this workflow, so its notes are someone else's ` +
        `to change: edit or delete it by hand, or cut a new version.`,
    );
  }
  if (!existing.isDraft) {
    throw new Error(
      `${tag} is already published. A release is immutable once it is out — bump the version and assemble the next ` +
        `release instead of rewriting this one.`,
    );
  }
  return { action: 'refresh', detail: `the draft for ${tag} was assembled by this workflow; refreshing it in place` };
}

/** The release using this tag, or null when there is none. */
export function existingRelease(tag, run = gh) {
  const view = run(['release', 'view', tag, '--json', 'isDraft,body,tagName']);
  if (view.status === 0) return JSON.parse(view.stdout);
  const output = `${view.stdout}${view.stderr}`.trim();
  // "Absent" has to be a specific answer: a lookup that failed because the API
  // was unreachable would otherwise be read as "no release yet", and the next
  // step would try to create one.
  if (/not found|HTTP 404/i.test(output)) return null;
  throw new Error(`could not read the release for ${tag}: ${output}${permissionHint(output)}`);
}

function compare(a, b) {
  const left = readFileSync(a);
  const right = readFileSync(b);
  return left.length === right.length && left.equals(right);
}

/**
 * Fill a draft release with `assetsDir`, then prove it by downloading the
 * assets back and comparing them with what was uploaded.
 */
export function fillDraft({ tag, assetsDir, title, body, downloadDir, run = gh, log = () => {} }) {
  const files = readdirSync(assetsDir)
    .filter((entry) => statSync(path.join(assetsDir, entry)).isFile())
    .map((entry) => path.join(assetsDir, entry))
    .sort();
  if (!files.some((file) => path.basename(file) === 'SHA256SUMS.txt')) {
    throw new Error(`no SHA256SUMS.txt in ${assetsDir} — assemble the release before publishing it`);
  }

  const plan = publicationPlan({ tag, existing: existingRelease(tag, run) });
  log(`  ${plan.detail}`);

  if (plan.action === 'create') {
    const create = ['release', 'create', tag, '--draft', '--verify-tag', '--title', title, '--notes-file', body];
    ok(run(create), create);
  } else {
    const edit = ['release', 'edit', tag, '--title', title, '--notes-file', body];
    ok(run(edit), edit);
  }

  const upload = ['release', 'upload', tag, ...files, '--clobber'];
  ok(run(upload), upload);
  log(`  uploaded ${files.length} assets to the draft`);

  // Reading the assets back is the whole point: an upload that truncated, or a
  // name that did not survive it, only shows up here.
  rmSync(downloadDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });
  const download = ['release', 'download', tag, '-D', downloadDir];
  ok(run(download), download);
  const downloaded = new Set(readdirSync(downloadDir));
  const problems = [];
  for (const file of files) {
    const name = path.basename(file);
    if (!downloaded.has(name)) problems.push(`${name}: not on the release`);
    else if (!compare(file, path.join(downloadDir, name))) problems.push(`${name}: differs from what was uploaded`);
    downloaded.delete(name);
  }
  for (const extra of downloaded) problems.push(`${extra}: on the release but not in ${assetsDir}`);
  if (problems.length) {
    throw new Error(`the draft does not carry what was assembled — ${problems.join('; ')}`);
  }
  log(`  read all ${files.length} assets back; every one matches what was uploaded`);

  return { action: plan.action, files: files.map((file) => path.basename(file)) };
}

/** Publish the draft this workflow assembled, and report what went out. */
export function publishDraft({ tag, run = gh, log = () => {} }) {
  const release = existingRelease(tag, run);
  const plan = publicationPlan({ tag, existing: release });
  if (plan.action !== 'refresh') throw new Error(`no draft of ours to publish for ${tag}: ${plan.detail}`);
  const edit = ['release', 'edit', tag, '--draft=false', '--latest'];
  ok(run(edit), edit);

  const view = ['release', 'view', tag, '--json', 'isDraft,assets,url'];
  const published = JSON.parse(ok(run(view), view).stdout);
  if (published.isDraft) throw new Error(`${tag} is still a draft after --draft=false`);
  log(`  published ${published.url}`);
  return {
    url: published.url,
    assets: (published.assets ?? []).map((asset) => ({ name: asset.name, size: asset.size })),
  };
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag') options.tag = argv[++i];
    else if (arg === '--assets') options.assetsDir = argv[++i];
    else if (arg === '--title-file') options.titlePath = argv[++i];
    else if (arg === '--body-file') options.bodyPath = argv[++i];
    else if (arg === '--download') options.downloadDir = argv[++i];
    else if (arg === '--publish') options.publish = true;
    else options.positional.push(arg);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const tag = options.tag ?? options.positional[0];
    const log = (line) => console.log(`publish-release:${line}`);
    if (!tag) throw new Error('pass --tag, e.g. `node scripts/publish-release.mjs --tag v0.2.3 --assets dist-release/assets`');

    if (options.publish) {
      const receipt = publishDraft({ tag, log });
      console.log(`publish-release: ${tag} is live — ${receipt.url} (${receipt.assets.length} assets)`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const rows = receipt.assets.map((asset) => `| \`${asset.name}\` | ${asset.size} |`).join('\n');
        writeFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### ${tag} is published\n\n${receipt.url}\n\n| asset | bytes |\n| --- | --- |\n${rows}\n`,
          { flag: 'a' },
        );
      }
    } else {
      const assetsDir = path.resolve(options.assetsDir ?? path.join(root, 'dist-release', 'assets'));
      const titlePath = path.resolve(options.titlePath ?? path.join(root, 'dist-release', 'RELEASE_TITLE.txt'));
      const bodyPath = path.resolve(options.bodyPath ?? path.join(root, 'dist-release', 'RELEASE_BODY.md'));
      const downloadDir = path.resolve(options.downloadDir ?? path.join(root, 'dist-release', 'downloaded'));
      for (const file of [titlePath, bodyPath]) {
        if (!existsSync(file)) throw new Error(`no ${path.relative(root, file)} — run \`npm run release:assemble\` first`);
      }
      const receipt = fillDraft({
        tag,
        assetsDir,
        title: readFileSync(titlePath, 'utf8').trim(),
        body: bodyPath,
        downloadDir,
        log,
      });
      console.log(`publish-release: the draft for ${tag} carries ${receipt.files.length} assets (${receipt.action})`);
      console.log(`publish-release: next — verify it, then publish: node scripts/publish-release.mjs --tag ${tag} --publish`);
    }
  } catch (err) {
    console.error(`publish-release: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
