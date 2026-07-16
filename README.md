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

After joining a room and creating `~/.acommune/config.json`, install the Claude Code hooks for the current project:

```sh
acommune hooks install
```

Use `--project <dir>` to target another project or `--user` to install the hooks in `~/.claude/settings.json`. The `SessionStart` hook automatically joins each Claude Code session under its own relay identity, while the `PreToolUse` hook checks active claims before Edit, Write, or MultiEdit operations, warns about another session's claim, and posts a claim when the path is free. Both hooks fail open by design: configuration, filesystem, relay, timeout, or parsing failures never block a session or an edit.
