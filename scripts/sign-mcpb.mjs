#!/usr/bin/env node
/**
 * Sign a built `.mcpb` with a code-signing certificate.
 *
 * Signing appends a PKCS#7 detached signature block to the bundle, so the
 * signed file is the reproducible bundle *plus that block*. The reproducible
 * bytes stay inside it, and `mcpb unsign` returns them exactly — which this
 * script asserts on every run, so the signed artifact can never drift from
 * the bundle CI proved identical across platforms.
 *
 * The private key is never read from the repository. Pass it by path, or
 * through `MCPB_KEY` / `MCPB_CERT`, and keep it outside version control.
 *
 * Usage:
 *   npm run mcpb:sign                                  (MCPB_CERT + MCPB_KEY)
 *   node scripts/sign-mcpb.mjs --cert c.pem --key k.pem [bundle.mcpb]
 *
 * A note on trust, because it decides what "signed" buys you: `mcpb verify`
 * and `mcpb info` only accept a signature when the certificate chains to
 * something in the OS trust store. A self-signed certificate does not, so a
 * host still reports "Not signed" until that certificate is installed — the
 * signature is real and checkable, but it is integrity and key continuity,
 * not third-party identity. A certificate issued by a public CA is what makes
 * hosts report it as signed.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Run the official mcpb CLI; throws with its output when it fails. */
function mcpbCli(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw new Error(`could not run the mcpb CLI: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`mcpb ${args[0]} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Sign `bundle` into `outPath` and prove the signature wraps the same bytes.
 * @returns {{ signedPath: string, signedHash: string, contentHash: string, subject: string, fingerprint: string, report: string }}
 */
export function signBundle({ bundle, cert, key, outPath }) {
  if (!existsSync(bundle)) throw new Error(`no bundle at ${bundle} — run \`npm run mcpb\` first`);
  if (path.resolve(bundle) === path.resolve(outPath)) {
    throw new Error('refusing to sign over the unsigned bundle: the reproducible artifact must stay untouched');
  }
  // These messages name the option, never the configured path: the path comes
  // from the environment, and a rule that treats environment values as
  // sensitive (CodeQL js/clear-text-logging, which flagged exactly this) is
  // right to — the log outlives the setup, and an env var is not a safe place
  // to assume a non-secret.
  if (!existsSync(cert)) throw new Error('the certificate file does not exist — check --cert / MCPB_CERT');
  if (!existsSync(key)) throw new Error('the private key file does not exist — check --key / MCPB_KEY');

  copyFileSync(bundle, outPath);
  const report = mcpbCli(['sign', '--cert', cert, '--key', key, outPath]);

  // A signature is only worth shipping if stripping it gives back the exact
  // bundle: that is what ties the signed artifact to the reproducible one.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'mcpb-unsign-'));
  try {
    const stripped = path.join(scratch, 'stripped.mcpb');
    copyFileSync(outPath, stripped);
    mcpbCli(['unsign', stripped]);
    if (!readFileSync(stripped).equals(readFileSync(bundle))) {
      rmSync(outPath, { force: true });
      throw new Error('unsigning the signed bundle did not reproduce the original bytes — not shipping it');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // The signature block is appended, so the signed file is strictly larger.
  if (statSync(outPath).size <= statSync(bundle).size) {
    rmSync(outPath, { force: true });
    throw new Error('the signed bundle is not larger than the unsigned one — no signature block was appended');
  }

  const certInfo = new X509Certificate(readFileSync(cert));
  const contentHash = sha256File(bundle);
  const signedHash = sha256File(outPath);

  // Same two-line shape as the bundle's own sidecar, so `sha256sum -c` can
  // check the signed artifact and the reproducible content in one command.
  writeFileSync(
    `${outPath}.sha256`,
    `${signedHash}  ${path.basename(outPath)}\n${contentHash}  ${path.basename(bundle)}\n`,
    'utf8',
  );

  return {
    signedPath: outPath,
    signedHash,
    contentHash,
    subject: certInfo.subject.replace(/\n/g, ', '),
    fingerprint: certInfo.fingerprint256,
    report: report.trim(),
  };
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cert') options.cert = argv[++i];
    else if (arg === '--key') options.key = argv[++i];
    else options.positional.push(arg);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const bundle = path.resolve(options.positional[0] ?? path.join(root, `${pkg.name}-${pkg.version}.mcpb`));
    const cert = options.cert ?? process.env.MCPB_CERT;
    const key = options.key ?? process.env.MCPB_KEY;

    if (!cert || !key) {
      console.error(
        'sign-mcpb: a certificate and private key are required — pass --cert/--key or set MCPB_CERT/MCPB_KEY.\n' +
          '           Keep the key outside the repository; see "Signing the bundle" in the README.',
      );
      process.exit(1);
    }

    const outPath = path.resolve(`${bundle.replace(/\.mcpb$/i, '')}.signed.mcpb`);
    const result = signBundle({ bundle, cert: path.resolve(cert), key: path.resolve(key), outPath });

    console.log(`sign-mcpb: signed ${path.relative(root, result.signedPath)}`);
    console.log(`  signer      ${result.subject}`);
    console.log(`  fingerprint ${result.fingerprint}`);
    console.log(`  content     ${result.contentHash}  ${path.basename(bundle)}`);
    console.log(`  signed      ${result.signedHash}`);
    console.log('  unsigned content byte-for-byte identical after `mcpb unsign`');
    console.log(
      '  hosts report "signed" only once this certificate is trusted by the OS; until then the\n' +
        '  signature is verifiable by the fingerprint above.',
    );
  } catch (err) {
    console.error(`sign-mcpb: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
