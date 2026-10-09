# Agent skill: playwright-e2e-mcp

`playwright-e2e-mcp/` is an [Agent Skill](https://agentskills.io/specification)
that teaches an agent when and how to use this repo's MCP server: the run, read
the failure, inspect, validate, fix and re-run loop, flaky-test diagnosis,
test generation and visual comparison. It works with any agent that reads
`SKILL.md` skills (Claude Code, Codex CLI, OpenClaw and others) once the MCP
server is connected.

```
playwright-e2e-mcp/
├── SKILL.md                     # when to use the skill and the step-by-step workflow
└── references/
    ├── setup.md                 # server install per client, env vars, skill install
    ├── tools.md                 # every tool's arguments
    ├── failure-kinds.md         # failure kinds, error codes and what to do
    └── example-session.md       # a worked fix-a-failing-test session
```

The skill contains only Markdown: no scripts, binaries or symlinks, and no
credentials.

## Packaging for a marketplace (Agensi)

Agensi expects one top-level folder named after the skill, with `SKILL.md` at
its root, text files only and no OS junk files. From this `skill/` directory:

```bash
zip -r playwright-e2e-mcp.zip playwright-e2e-mcp -x "*.DS_Store" "*Thumbs.db"
```

Keep the skill's `name` in `SKILL.md` equal to the folder name.
