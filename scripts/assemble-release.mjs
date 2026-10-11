#!/usr/bin/env node
/**
 * Assemble a release: the artifacts, their checksums, and the notes.
 *
 * A release used to be assembled by hand — `npm run mcpb`, sign it, `npm pack`,
 * `sha256sum`, and then write the release body out of what those commands
 * printed. Every one of those numbers was retyped, and the bundle hash in the
 * notes had to match a file nobody compared it against. This script does the
 * assembly instead: it stages each artifact, hashes what it staged, and writes
 * the body from those hashes, so the numbers in the notes cannot be stale by
 * construction.
 *
 * The prose stays human: `release-notes/<tag>.md` is written and reviewed in the
 * commit that bumps the version, and this script appends the parts that are
 * facts — the asset table, the reproduction recipe with the real bundle hash,
 * the signer, the commit list. Anything in that file claiming a hash is checked
 * against the artifacts, because a hand-typed hash is the drift this exists to
 * remove.
 *
 * Usage:
 *   npm run mcpb && npm pack                # the bundle and the tarball
 *   node scripts/assemble-release.mjs --tag v0.2.3 [--key k.pem --cert c.pem]
 *
 * Output (dist-release/ by default):
 *   assets/                 every file the release carries, and SHA256SUMS.txt
 *   RELEASE_TITLE.txt       the release title, from the notes' H1
 *   RELEASE_BODY.md         what `gh release create --notes-file` gets
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSkillZip } from './package-skill.mjs';
import { sha256File, signBundle } from './sign-mcpb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * First line of every generated body. A re-run needs to know whether the draft
 * it finds under this tag is its own (safe to refresh) or a release someone
 * wrote by hand (never overwritten).
 */
export const ASSEMBLED_MARKER = '<!-- release:assembled -->';

/** The heading this script owns, so a stale hand-written table cannot survive. */
const GENERATED_HEADING = '### Assets';

/** `https://github.com/owner/repo` from the package.json repository field. */
export function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return raw ? raw.replace(/^git\+/, '').replace(/\.git$/, '') : null;
}

/**
 * The tag, package.json and server.json have to agree before anything is
 * built: asset names and the registry entry carry the version, so a mismatch
 * would publish the right files under the wrong release.
 */
export function validateVersions({ tag, pkg, server }) {
  const problems = [];
  if (!/^v\d+\.\d+\.\d+/.test(tag)) problems.push(`'${tag}' is not a release tag (expected v<major>.<minor>.<patch>)`);
  const version = tag.replace(/^v/, '');
  if (pkg.version !== version) problems.push(`package.json says ${pkg.version}, the tag says ${tag}`);
  if (server) {
    const listed = server.packages?.[0]?.version;
    if (server.version !== version) problems.push(`server.json says ${server.version}, the tag says ${tag}`);
    if (listed !== undefined && listed !== version) problems.push(`server.json packages[0] says ${listed}, the tag says ${tag}`);
  }
  if (problems.length) throw new Error(`the versions do not agree: ${problems.join('; ')}`);
  return version;
}

/**
 * The notes for this release: `release-notes/<tag>.md`, whose H1 is the
 * release title and whose remainder is the top of the body.
 */
export function readNotes({ dir = root, tag }) {
  const file = path.join(dir, 'release-notes', `${tag}.md`);
  if (!existsSync(file)) {
    throw new Error(
      `no release notes at release-notes/${tag}.md — write them in the commit that bumps the version to ${tag}, ` +
        `then re-run. A release without notes is a release nobody can read.`,
    );
  }
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const titleAt = lines.findIndex((line) => line.trim() !== '');
  const title = lines[titleAt] ?? '';
  if (!title.startsWith('# ')) {
    throw new Error(`release-notes/${tag}.md has to start with its title as an H1, e.g. "# ${tag} — what changed"`);
  }
  if (!title.includes(tag)) {
    throw new Error(`release-notes/${tag}.md titles this release "${title.trim()}" — the H1 has to name ${tag}`);
  }
  const body = lines
    .slice(titleAt + 1)
    .join('\n')
    .trim();
  if (!body) throw new Error(`release-notes/${tag}.md has a title but no notes below it`);
  const heading = body.split('\n').find((line) => line.trim() === GENERATED_HEADING);
  if (heading) {
    throw new Error(
      `release-notes/${tag}.md writes its own "${GENERATED_HEADING}" section — that table is generated from the ` +
        `artifacts so its hashes cannot go stale. Describe the release instead; the table is appended for you.`,
    );
  }
  return { file, title: title.slice(2).trim(), body };
}

/**
 * A hash written in the prose has to be a hash this release publishes. The
 * whole point is that the numbers come from the assembly: a typed one is a
 * number nobody compared against a file.
 */
export function checkStatedHashes({ notes, text, allowed, tag }) {
  const wrong = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(/\b[0-9a-f]{64}\b/g)) {
      if (!allowed.has(match[0])) wrong.push({ line: index + 1, hash: match[0] });
    }
  }
  if (wrong.length) {
    const detail = wrong.map((w) => `line ${w.line}: ${w.hash}`).join('; ');
    throw new Error(
      `release-notes/${tag}.md states ${wrong.length === 1 ? 'a hash' : 'hashes'} this release does not publish ` +
        `(${detail}). The asset hashes, the lockfile hash and the signer are appended by this script — leave them ` +
        `out of the prose so they cannot disagree with the files.`,
    );
  }
  return notes;
}

/** Every hash a reader of the notes could legitimately have copied. */
function publishedHashes(assetsDir, assets) {
  const allowed = new Set(assets.map((asset) => asset.sha256));
  for (const name of readdirSync(assetsDir)) {
    if (!name.endsWith('.sha256')) continue;
    for (const match of readFileSync(path.join(assetsDir, name), 'utf8').matchAll(/^([0-9a-f]{64})/gm)) {
      allowed.add(match[1]);
    }
  }
  return allowed;
}

/**
 * What each asset is, in the order a reader wants them: the artifact they came
 * for first, the checksums for it last. The same order is used for
 * SHA256SUMS.txt, so the table and the checksum file are one list.
 */
function assetGuide({ name, version }) {
  const base = `${name}-${version}`;
  return [
    [`${base}.mcpb`, 'the bundle — `npm ci && npm run mcpb` on this tag rebuilds these exact bytes'],
    [`${base}.signed.mcpb`, 'the same bundle with a PKCS#7 signature block appended'],
    [`${name}-signing-cert.pem`, 'the public certificate the signature chains to'],
    [`${base}.tgz`, 'the npm tarball `npm pack` writes from this tag'],
    [`${base}-skill.zip`, 'the Agent Skill package, built by `npm run skill:zip`'],
    [`${base}.mcpb.sha256`, 'the bundle\u2019s hash, and the lockfile hash it was built from'],
    [`${base}.signed.mcpb.sha256`, 'the signed bundle\u2019s hash, and the reproducible bytes it wraps'],
  ];
}

/** Every file in `dir` except SHA256SUMS.txt, described and ranked. */
export function collectAssets(dir, { name, version }) {
  const guide = assetGuide({ name, version });
  const rank = new Map(guide.map(([asset], index) => [asset, index]));
  const assets = readdirSync(dir)
    .filter((entry) => entry !== 'SHA256SUMS.txt')
    .filter((entry) => statSync(path.join(dir, entry)).isFile())
    .map((entry) => {
      const at = rank.get(entry);
      return {
        name: entry,
        sha256: sha256File(path.join(dir, entry)),
        bytes: statSync(path.join(dir, entry)).size,
        rank: at === undefined ? guide.length : at,
        description: at === undefined ? 'an asset of this release' : guide[at][1],
      };
    });
  // Name breaks ties so two builds of one tree list assets in the same order.
  return assets.sort((a, b) => a.rank - b.rank || (a.name < b.name ? -1 : 1));
}

/**
 * `sha256sum` output over everything staged. It covers every file in the
 * directory, so an artifact cannot be added to a release without being
 * covered — which is the check `verify-release` runs against a download.
 */
export function writeChecksums(dir, assets) {
  const text = assets.map((asset) => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), text, 'utf8');
  return assets;
}

/** Commits between the previous release tag and this one, newest first. */
export function commitsSince({ tag, cwd = root, limit = 200 }) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? `${result.stdout}`.trim() : null;
  };
  const previousTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`]);
  const entries = (git(['log', '--no-merges', '--pretty=%h %s', previousTag ? `${previousTag}..${tag}` : tag]) ?? '')
    .split('\n')
    .filter(Boolean);
  return { previousTag, total: entries.length, entries: entries.slice(0, limit) };
}

/**
 * The release body: the reviewed prose, then what the assembly knows for
 * certain. @returns {string}
 */
export function releaseBody({ tag, notes, assets, signer = null, commits = null, pkg }) {
  const version = tag.replace(/^v/, '');
  const bundle = assets.find((asset) => asset.name === `${pkg.name}-${version}.mcpb`);
  const clone = repositoryUrl(pkg);
  const lines = [
    ASSEMBLED_MARKER,
    `> Assembled from \`${tag}\` by \`.github/workflows/release.yml\`: the hashes, the signer and the commit list ` +
      `below come from that run. To change the prose, edit \`release-notes/${tag}.md\` — not this body.`,
    '',
    notes.body,
    '',
    GENERATED_HEADING,
    '',
    '| asset | sha256 | what it is |',
    '| --- | --- | --- |',
    ...assets.map((asset) => `| \`${asset.name}\` | \`${asset.sha256}\` | ${asset.description} |`),
    '',
    '`SHA256SUMS.txt` carries those hashes:',
    '',
    '```bash',
    'sha256sum -c SHA256SUMS.txt',
    '```',
  ];

  if (bundle) {
    lines.push(
      '',
      '### Reproducing the bundle',
      '',
      '```bash',
      ...(clone ? [`git clone ${clone} && cd ${path.basename(clone)}`] : []),
      `git checkout ${tag}`,
      'npm ci && npm run mcpb',
      `sha256sum ${bundle.name}`,
      `# ${bundle.sha256}`,
      '```',
      '',
      `Or in one command, from a checkout of the tag: \`npm run release:verify -- ${tag}\`.`,
    );
  }

  if (signer) {
    lines.push(
      '',
      '### The signature',
      '',
      `\`${signer.signedName}\` is \`${bundle?.name}\` plus a PKCS#7 signature block, so \`mcpb unsign\` gives ` +
        'back exactly those bytes.',
      '',
      `- **Signer:** \`${signer.subject}\``,
      `- **SHA-256 fingerprint:** \`${signer.fingerprint}\``,
      '',
      `The certificate is published as \`${signer.certName}\`; the private key is not in the repository and never ` +
        'leaves the machine that signs. Whether a host reports this as signed is decided by the certificate, not by ' +
        'the signature: it has to chain into the host\u2019s trust store.',
    );
  } else {
    lines.push(
      '',
      'This release is **unsigned**: no signing key was configured for it, so there is no `.signed.mcpb` and no ' +
        'certificate to check it against.',
    );
  }

  if (commits && commits.total > 0) {
    const from = commits.previousTag ? `from ${commits.previousTag} to ${tag}` : `up to ${tag}`;
    const hidden = commits.total - commits.entries.length;
    lines.push(
      '',
      '### Commits',
      '',
      `<details><summary>${commits.total} commit${commits.total === 1 ? '' : 's'} ${from}</summary>`,
      '',
      ...commits.entries.map((entry) => `- \`${entry.replace(' ', '` ')}`),
      ...(hidden > 0 ? ['', `(\u2026 and ${hidden} earlier)`] : []),
      '',
      '</details>',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Stage the whole release into `assetsDir` and write the body and title beside
 * it.
 *
 * `assetsDir` belongs to this script: it is emptied first, because a file left
 * over from an earlier run would otherwise be hashed and published as if this
 * run had produced it.
 *
 * @returns {{ tag: string, title: string, body: string, assets: object[], signer: object|null }}
 */
export function assembleRelease({
  tag,
  assetsDir = path.join(root, 'dist-release', 'assets'),
  bundle,
  tarball,
  cert,
  key,
  bodyPath,
  titlePath,
  notesDir = root,
  log = () => {},
}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const serverPath = path.join(root, 'server.json');
  const server = existsSync(serverPath) ? JSON.parse(readFileSync(serverPath, 'utf8')) : null;
  const version = validateVersions({ tag, pkg, server });

  const notes = readNotes({ dir: notesDir, tag });

  const bundlePath = path.resolve(bundle ?? path.join(root, `${pkg.name}-${version}.mcpb`));
  if (!existsSync(bundlePath)) throw new Error(`no bundle at ${path.relative(root, bundlePath)} — run \`npm run mcpb\` first`);
  if (!existsSync(`${bundlePath}.sha256`)) {
    throw new Error(`no sidecar at ${path.relative(root, `${bundlePath}.sha256`)} — run \`npm run mcpb\` first`);
  }
  const tarballPath = path.resolve(tarball ?? path.join(root, `${pkg.name}-${version}.tgz`));
  if (!existsSync(tarballPath)) {
    throw new Error(`no tarball at ${path.relative(root, tarballPath)} — run \`npm pack\` first`);
  }

  if (existsSync(assetsDir)) {
    if (readdirSync(assetsDir).some((entry) => entry === '.git' || entry === 'package.json')) {
      throw new Error(`${assetsDir} looks like a checkout, not the release's asset directory — refusing to empty it`);
    }
    rmSync(assetsDir, { recursive: true, force: true });
  }
  mkdirSync(assetsDir, { recursive: true });

  const stage = (from, to = path.join(assetsDir, path.basename(from))) => {
    copyFileSync(from, to);
    log(`  staged ${path.basename(to)}`);
    return to;
  };

  stage(bundlePath);
  stage(`${bundlePath}.sha256`);
  stage(tarballPath, path.join(assetsDir, `${pkg.name}-${version}.tgz`));

  // The skill package is built here rather than copied: it is byte-identical to
  // `npm run skill:zip`, and building it keeps one writer for the archive.
  writeFileSync(path.join(assetsDir, `${pkg.name}-${version}-skill.zip`), buildSkillZip());
  log(`  built ${pkg.name}-${version}-skill.zip`);

  let signer = null;
  if (cert || key) {
    if (!cert || !key) throw new Error('signing needs both --cert and --key (or neither)');
    const signedPath = path.join(root, `${pkg.name}-${version}.signed.mcpb`);
    const signed = signBundle({ bundle: bundlePath, cert: path.resolve(cert), key: path.resolve(key), outPath: signedPath });
    stage(signedPath);
    stage(`${signedPath}.sha256`);
    const certName = stage(path.resolve(cert), path.join(assetsDir, `${pkg.name}-signing-cert.pem`));
    signer = {
      subject: signed.subject,
      fingerprint: signed.fingerprint,
      signedName: path.basename(signedPath),
      contentHash: signed.contentHash,
      certName: path.basename(certName),
    };
    log(`  signed with ${signed.subject}`);
  }

  // Re-read the staged bytes rather than trusting the copies above: everything
  // the body and SHA256SUMS.txt state is then a fact about the published files.
  const assets = writeChecksums(assetsDir, collectAssets(assetsDir, { name: pkg.name, version }));

  // Only now can the prose be checked: "a hash you typed has to be one of the
  // files below" needs the files to exist first.
  checkStatedHashes({ notes, text: notes.body, allowed: publishedHashes(assetsDir, assets), tag });

  const commits = commitsSince({ tag, cwd: root });
  const body = releaseBody({ tag, notes, assets, signer, commits, pkg });
  const outDir = path.dirname(assetsDir);
  writeFileSync(resolveOut(bodyPath, outDir, 'RELEASE_BODY.md'), body, 'utf8');
  writeFileSync(resolveOut(titlePath, outDir, 'RELEASE_TITLE.txt'), `${notes.title}\n`, 'utf8');

  return { tag, title: notes.title, body, assets, signer, commits };
}

function resolveOut(given, outDir, fallback) {
  return path.resolve(given ?? path.join(outDir, fallback));
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tag') options.tag = argv[++i];
    else if (arg === '--assets') options.assetsDir = argv[++i];
    else if (arg === '--bundle') options.bundle = argv[++i];
    else if (arg === '--tarball') options.tarball = argv[++i];
    else if (arg === '--key') options.key = argv[++i];
    else if (arg === '--cert') options.cert = argv[++i];
    else if (arg === '--body-file') options.bodyPath = argv[++i];
    else if (arg === '--title-file') options.titlePath = argv[++i];
    else options.positional.push(arg);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  try {
    const options = parseArgs(process.argv.slice(2));
    const tag = options.tag ?? options.positional[0] ?? `v${pkg.version}`;
    const result = assembleRelease({ ...options, tag, log: (line) => console.log(`assemble-release:${line}`) });
    console.log(`assemble-release: assembled ${result.tag} (${result.assets.length} assets)`);
    for (const asset of result.assets) console.log(`  ${asset.sha256}  ${asset.name}`);
    console.log(`assemble-release: title  ${result.title}`);
    console.log(
      `assemble-release: body   ${path.relative(root, resolveOut(options.bodyPath, path.dirname(options.assetsDir ?? path.join(root, 'dist-release', 'assets')), 'RELEASE_BODY.md'))}`,
    );
    console.log(
      result.signer
        ? `assemble-release: signed by ${result.signer.subject} (${result.signer.fingerprint})`
        : 'assemble-release: unsigned — no --key/--cert given',
    );
  } catch (err) {
    console.error(`assemble-release: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
