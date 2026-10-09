# Setup: connecting the playwright-e2e-mcp server

This skill only gives the agent instructions. The tools come from the
`playwright-e2e-mcp` MCP server, which must be connected to the agent.

## Requirements

- Node.js 20 or newer.
- A project with `@playwright/test` installed and a browser available:
  `npx playwright install chromium`.

## Install the server

The server is published on npm as `playwright-e2e-mcp` and in the official MCP
Registry as `io.github.trajectiq-ai/E2E`. Pin a version in shared configs
(`playwright-e2e-mcp@<version>`) so every machine runs the same build.

**Claude Code**

```bash
claude mcp add playwright-e2e -- npx -y playwright-e2e-mcp
```

**Claude Desktop, Cursor, Windsurf, Gemini CLI, Qwen Code and other JSON-config clients**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "npx",
      "args": ["-y", "playwright-e2e-mcp"],
      "env": { "PW_MCP_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

Claude Desktop also has a one-click `.mcpb` extension on the project's
[GitHub releases](https://github.com/trajectiq-ai/E2E/releases); it asks for the
project root on install.

**Codex CLI**

```toml
# ~/.codex/config.toml
[mcp_servers.playwright-e2e]
command = "npx"
args = ["-y", "playwright-e2e-mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

Raise the timeouts as shown: a Playwright run with retries takes longer than
Codex's 60-second default tool timeout.

## Install the skill

Copy the `playwright-e2e-mcp/` folder (the one holding `SKILL.md`) into your
agent's skills directory, for example:

- Claude Code: `~/.claude/skills/` (personal) or `.claude/skills/` (project)
- Codex CLI: `~/.codex/skills/`
- Other agents: their documented skills folder

## Environment variables

Set these in the server's `env` block. None of them are secrets except
`PW_MCP_HTTP_TOKEN`; never put a token in a committed config file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PW_MCP_PROJECT_ROOT` | server working directory | Default project root for every tool |
| `PW_MCP_ALLOWED_ROOTS` | none | Extra directories allowed as `projectRoot` (`:`-separated, `;` on Windows) |
| `PW_MCP_BLOCK_PRIVATE_URLS` | off for stdio | `1` makes the URL tools refuse loopback, private-network and cloud-metadata addresses |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `PW_MCP_HTTP_TOKEN` | none | HTTP bridge only: bearer token that unlocks all tools |

## Hosted endpoint

Clients that only accept remote MCP servers can use the Streamable HTTP bridge
(`https://playwright-e2e-mcp.vercel.app/api/mcp`, or your own deployment of the
repo). Without a bearer token the bridge serves only `list-tests` and
`get-failure`, so the core loop in `SKILL.md` needs a local install or a token.

## Check it works

Ask the agent to "list my Playwright tests". It should call `list-tests` and
return files and titles. If it says the tools are missing, the server is not
connected: restart the client after editing its config.
