# Hosted Auth, Onboarding, MCP Client Presets

## Decision

Poolstatis hosted onboarding is agent-first, not Claude-only.

Supported UI presets:

- Claude Code
- Claude Desktop
- Codex
- Cursor
- Warp
- Windsurf
- VS Code / Copilot
- Cline
- Zed
- Continue
- Replit
- OpenCode
- Hermes-style launchers
- Custom MCP host

Claude can be one preset, but copy must not say that Poolstatis only works with Claude. The underlying contract is a stdio MCP server config with:

```json
{
  "mcpServers": {
    "poolstatis": {
      "command": "pnpm",
      "args": ["--silent", "dlx", "@poolstatis/mcp"],
      "env": {
        "POOLSTATIS_URL": "https://api.poolstatis.com",
        "POOLSTATIS_TOKEN": "pt_or_sk"
      }
    }
  }
}
```

This command is publish-ready. Keep the hosted runner status as `publish_pending` until the npm package or another real MCP runner command is available.

## Product Rules

- Hosted auth is for humans in the admin.
- `pk_`, `sk_`, and `pt_` remain the runtime/API/MCP access model.
- Onboarding creates the first project plus one-time `pt_` and `pk_` tokens.
- Repeat onboarding must be blocked after the first project exists; new `pt_` tokens are issued through an explicit hosted UI action.
- Setup & MCP should let the user choose a client preset and should show a token placeholder for hosted users.
- MCP presets are templates unless the hosted deploy marks the runner package as published/configured.
- Public copy should say "agent workspace", "MCP client", or "coding agent" unless it is naming a specific preset.
- Future pricing is `$0` now, with billing meters already modeled in DB: events, monthly tracked users, retained entities, projects, retention months, seats.

## Verification Expectations

- Run backend tests after auth/schema changes.
- Run `pnpm --dir web build` after admin UI changes. Landing/public docs changes
live in `/Users/maksimstil/Desktop/poolstatis-site` and should be verified there
  with `pnpm build`.
- Use browser E2E for signup/onboarding/setup surfaces, including mobile overflow and console errors.
- Request subagent code review and UI review before finalizing broad auth/onboarding changes.
