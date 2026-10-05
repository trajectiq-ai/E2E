#!/usr/bin/env node
// Validates .agents/mcp.json files against Freebuff's actual mcpFileSchema
// (mirrored from CodebuffAI/freebuff sdk/src/agents/load-mcp-config.ts +
//  common/src/types/mcp.ts) using this project's zod v4.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const mcpConfigStdioSchema = z.strictObject({
  type: z.literal('stdio').default('stdio'),
  command: z.string(),
  args: z.string().array().default(() => []),
  env: z.record(z.string(), z.string()).default(() => ({})),
});
const mcpConfigRemoteSchema = z.strictObject({
  type: z.enum(['http', 'sse']).default('http'),
  url: z.string(),
  params: z.record(z.string(), z.string()).default(() => ({})),
  headers: z.record(z.string(), z.string()).default(() => ({})),
});
const mcpConfigSchema = z.union([mcpConfigRemoteSchema, mcpConfigStdioSchema]);
const mcpFileSchema = z.object({
  mcpServers: z.record(z.string(), mcpConfigSchema).default(() => ({})),
});

const files = process.argv.slice(2);
let failed = false;
for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const result = mcpFileSchema.safeParse(raw);
  if (!result.success) {
    console.error(`FAIL ${file}: ${result.error.message}`);
    failed = true;
    continue;
  }
  const servers = Object.entries(result.data.mcpServers).map(
    ([name, cfg]) => `${name} -> ${'command' in cfg ? `${cfg.command} ${cfg.args.join(' ')}` : cfg.url}`,
  );
  console.log(`OK   ${file} (${servers.join('; ')})`);
}
process.exit(failed ? 1 : 0);
