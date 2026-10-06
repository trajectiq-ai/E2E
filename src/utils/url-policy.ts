/**
 * SSRF guard for the URL tools (inspect-page, validate-selector,
 * compare-visual-state, generate-e2e-test's live check).
 *
 * Locally these tools exist to open http://localhost dev servers, so the
 * guard is off by default. The HTTP bridge turns it on, and
 * PW_MCP_BLOCK_PRIVATE_URLS=1 turns it on for stdio. When on, a URL whose
 * host resolves to a loopback, private, link-local (cloud metadata),
 * CGNAT, multicast or reserved address is refused, and the browser probe
 * aborts every request (redirects and subresources included) that does.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { PlaywrightMcpError } from '../types/index.js';

/** CIDR ranges a guarded tool must not reach. Also sent to the probe script. */
export const BLOCKED_RANGES: ReadonlyArray<{ address: string; prefix: number; family: 'ipv4' | 'ipv6' }> = [
  { address: '0.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '100.64.0.0', prefix: 10, family: 'ipv4' },
  { address: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { address: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { address: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { address: '192.0.0.0', prefix: 24, family: 'ipv4' },
  { address: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { address: '198.18.0.0', prefix: 15, family: 'ipv4' },
  { address: '224.0.0.0', prefix: 4, family: 'ipv4' },
  { address: '240.0.0.0', prefix: 4, family: 'ipv4' },
  // IPv6: unspecified, loopback and IPv4-compatible (::a.b.c.d) in one /96,
  // then the forms that embed or translate to an IPv4 address (SIIT, NAT64,
  // 6to4, Teredo), discard, ULA, site/link-local, multicast. IPv4-mapped
  // (::ffff:a.b.c.d) is not listed: BlockList checks every IPv4 address
  // against IPv6 rules in that form, so a ::ffff:0:0/96 rule would block all
  // of IPv4. Mapped addresses are checked against the IPv4 rules instead.
  { address: '::', prefix: 96, family: 'ipv6' },
  { address: '::ffff:0:0:0', prefix: 96, family: 'ipv6' },
  { address: '64:ff9b::', prefix: 96, family: 'ipv6' },
  { address: '64:ff9b:1::', prefix: 48, family: 'ipv6' },
  { address: '100::', prefix: 64, family: 'ipv6' },
  { address: '2001::', prefix: 32, family: 'ipv6' },
  { address: '2002::', prefix: 16, family: 'ipv6' },
  { address: 'fec0::', prefix: 10, family: 'ipv6' },
  { address: 'fc00::', prefix: 7, family: 'ipv6' },
  { address: 'fe80::', prefix: 10, family: 'ipv6' },
  { address: 'ff00::', prefix: 8, family: 'ipv6' },
];

const blockList = new BlockList();
for (const range of BLOCKED_RANGES) blockList.addSubnet(range.address, range.prefix, range.family);

let blockPrivate = false;

/** Turn the guard on or off for this process (the HTTP bridge turns it on). */
export function setBlockPrivateUrls(enabled: boolean): void {
  blockPrivate = enabled;
}

/** True when private-network URLs must be refused. */
export function blockPrivateUrls(): boolean {
  return blockPrivate || process.env.PW_MCP_BLOCK_PRIVATE_URLS === '1';
}

/** True for an IP address inside BLOCKED_RANGES (IPv4-mapped IPv6 included). */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return blockList.check(mapped[1], 'ipv4');
  const family = isIP(bare);
  if (family === 4) return blockList.check(bare, 'ipv4');
  if (family === 6) return blockList.check(bare, 'ipv6');
  return false;
}

/**
 * Throw INVALID_PATH when the guard is on and `url`'s host is, or resolves
 * to, a blocked address. A host that does not resolve is left to the
 * browser, which reports it as unreachable.
 */
export async function assertUrlAllowed(url: string): Promise<void> {
  if (!blockPrivateUrls()) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      return;
    }
  }
  const blocked = addresses.find((address) => isBlockedAddress(address));
  if (blocked) {
    throw new PlaywrightMcpError(`"${url}" points at a private or reserved address (${blocked})`, 'INVALID_PATH', {
      hint: 'This server blocks loopback, private-network and cloud-metadata addresses. Use a public URL.',
    });
  }
}
