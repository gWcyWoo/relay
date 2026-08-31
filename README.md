# Relay

Local Claude Code ↔ Codex Desktop session bridge. A pair of session IDs becomes
one `bridgeId`; both models see only one MCP tool:

```text
send(bridgeId, message)
```

The proxy uses only supported interfaces: Claude Code MCP Channels and Codex
App Server. It does not automate either desktop UI or modify private session
storage.

## Start

Requires Node.js 24+, a Channels-enabled Claude Code release, and `codex` in
`PATH`.

```bash
npm install
npm link
relay pair --codex=<CODEX_THREAD_ID> --claude=<CLAUDE_SESSION_UUID>
relay serve
```

`pair` prints a unique five-digit `bridgeId` such as `48217`; if a generated ID
already exists in the store, it retries without replacing the existing pair.
The store is managed internally and is not part of the public command.
Previously created longer IDs remain valid. `serve` launches the proxy at
`http://127.0.0.1:8765` and starts `codex app-server`.

Register the session-specific endpoints:

```bash
claude mcp add --transport http --scope user relay \
  http://127.0.0.1:8765/mcp/claude/<CLAUDE_SESSION_UUID>

codex mcp add relay --url \
  http://127.0.0.1:8765/mcp/codex/<CODEX_THREAD_ID>
```

Start or resume Claude Code with the same UUID, Remote Control, and the Channel:

```bash
claude --resume <CLAUDE_SESSION_UUID> --remote-control \
  --dangerously-load-development-channels server:relay
```

Then either model calls `send` with the `bridgeId`. Messages from
Claude resume the paired Codex thread and start a turn. Messages from Codex are
pushed into the connected Claude session as Channel events.

## Commands

```text
relay pair --codex=<thread-id> --claude=<session-id>
relay serve [--host 127.0.0.1] [--port 8765]
```

The SQLite store preserves pairings and delivered/failed delivery records over
proxy restarts. Unknown bridges, mismatched source sessions, disconnected
Claude Channels, App Server failures, and invalid CLI arguments fail visibly.

After the proxy process restarts, resume the Claude Code session with the same
UUID and development-Channel option so its HTTP Channel reconnects. The stored
`bridgeId` does not change and does not need to be paired again.

Codex App Server allows only one active writer for a thread. Delivery to a
Codex task that is currently generating fails visibly with `already has an
active writer`; send when that task is idle. A Codex turn that asks Claude a
question should end after calling `send`, releasing its writer before
Claude's reply arrives.
