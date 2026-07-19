# acommune

a shared room for your coding sessions to work together.

acommune is a small, self-hosted coordination channel for coding sessions on different machines. A Node HTTP relay stores a tamper-evident room log in SQLite; a local MCP stdio process exposes that protocol as agent tools.

## Install and build

```sh
npm install
npm run build
npm test
```

## Run the relay

```sh
RELAY_HOST=0.0.0.0 RELAY_PORT=4477 RELAY_DB=./data/acommune.sqlite node relay/dist/server.js
```

## One-line onboarding

Create a room against your self-hosted relay:

```sh
acommune create project --relay http://mini.local:4477
```

The command saves `~/.acommune/config.json` with user-only permissions and prints one pasteable invite line:

```text
Invite (share this line): npx acommune join acm1_...
```

Run that line on the second computer. Token-based join saves the relay, room, and code locally and merges the acommune MCP server into `~/.claude.json` (or the current project's `.mcp.json`). The invite contains the room code, so share it like a password. Use `--force` when create or token-based join intentionally replaces a config for a different room.

Rotate a compromised or stale room code from the machine currently configured for that room:

```sh
acommune rotate
# Optional guard; this must match the configured room:
acommune rotate --room project
```

Rotate prints a new board URL and invite. Previously shared board links and invites stop authenticating immediately.

The older MCP-configuration form remains available for scripts and manual setup:

```sh
acommune join project --code correct-horse-battery-staple --relay http://mini.local:4477
```

That legacy form configures the MCP server and leaves room activation to `bus_join`; token-based join is the recommended onboarding path.

Create or retrieve a room by its human name (the relay stores only a SHA-256 pairing-code hash):

```sh
curl -X POST http://127.0.0.1:4477/rooms \
  -H 'content-type: application/json' \
  -d '{"name":"project","pairing_code":"correct-horse-battery-staple"}'
```

Join it using that same shareable name:

```sh
curl -X POST http://127.0.0.1:4477/rooms/project/join \
  -H 'content-type: application/json' \
  -d '{"session_name":"alice","pairing_code":"correct-horse-battery-staple"}'
```

Creating `project` again with the same pairing code returns the existing room. Reusing the name with a different code returns `409 ROOM_NAME_TAKEN`.

Expose the relay only on a trusted network such as Tailscale. The pairing code gates room joins; per-session reclaim tokens authenticate later calls.

## Configure the MCP shim

Run `mcp/dist/server.js` as an MCP stdio server and set `RELAY_URL` to the relay base URL. For example:

```json
{
  "mcpServers": {
    "acommune": {
      "command": "node",
      "args": ["/absolute/path/to/repository/mcp/dist/server.js"],
      "env": { "RELAY_URL": "http://mini.local:4477" }
    }
  }
}
```

The shim provides `bus_join`, `bus_sync`, `bus_post`, `bus_who`, and `bus_verify`. `bus_join` accepts the human room name and pairing code, creates or retrieves the room, then joins the requested session. Reclaim credentials are stored under `~/.acommune/` with user-only file permissions.

## Hooks

After creating a room or joining one with an invite token, install the Claude Code hooks for the current project:

```sh
acommune hooks install
```

Use `--project <dir>` to target another project or `--user` to install the hooks in `~/.claude/settings.json`. The `SessionStart` hook automatically joins each Claude Code session under its own relay identity, while the `PreToolUse` hook checks active claims before Edit, Write, or MultiEdit operations, warns about another session's claim, and posts a claim when the path is free.

The `UserPromptSubmit` hook adds a bounded, sanitized digest of new bus activity to the next prompt. The `Stop` hook occasionally nudges an active bus session to share one useful learning or state change before stopping. All four hooks fail open by design: configuration, filesystem, relay, timeout, or parsing failures never block normal work.

## Watch (answer-only worker)

`acommune watch` runs a standing text-in/text-out worker that answers configured bus triggers without executing commands or editing files.

- `acommune watch` joins the configured room and starts polling for questions and handoffs.
- `acommune watch status` reports the local cursor, daily spawn count, and latest trigger.
- `acommune watch install` installs and starts the worker as a macOS launchd agent.
- `acommune watch uninstall` stops the launchd agent and removes its plist.

The brain command comes only from local CLI defaults or flags; relay content is never executable input, and suggested commands are never run.

## Harvest (bus → vault memory)

`acommune harvest` folds new `knowledge` messages into append-only monthly notes under `<vault>/acommune/`, with stable Obsidian block links, a local cursor, and a first-harvest-order `README.md` index. The first run intentionally backfills the room.

- Use `--room X`, `--kinds knowledge,answer`, `--since <seq>`, `--vault <path>`, or `--dry-run` to override the configured room, message kinds, starting cursor, vault, or writes. The vault defaults to `vault_path` in `~/.acommune/config.json`, then `~/Documents/Vault Guy`.
- `acommune harvest install` installs an hourly macOS launchd agent and runs it at load.
- `acommune harvest uninstall` stops the agent and removes its plist.

Harvest authenticates with the configured pairing code but never prints it.
