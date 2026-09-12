# Relay

Session-to-session messaging between AI coding sessions (Claude Code, Codex
desktop), on one machine or across a LAN. Each machine runs one Relay; sessions
talk to it over MCP, Relays talk to each other over HTTP.

Three tools, identical for every provider:

```text
register(sessionId, role, token?)   → { token, bound: [...] }
send(message, selfSessionId, target, role?, urgent?)
unregister(sessionId)
```

## How sessions find each other

A registered session gets a **token** (`secret@host:port`): its address, valid
as long as it stays registered. Hand that token to another session and let it
call `register` with it; the two are now **bound**, on both sides, whether they
share a Relay or not. Each further token adds one more binding, so a Claude
session can be bound to a local Codex and to two Codex sessions on other
machines at once. The token never appears in `send`: sessions address bound
counterparts by provider and role, or by sessionId when two share a role.

```text
Claude (machine A):  register("cl-1", "架构师")             → token T
Codex  (machine B):  register("thread-42", "executor", T)   → bound to cl-1
Codex:               send("...", "thread-42", "claude", "架构师")
Claude:              send("...", "cl-1", "codex", "executor")
```

Registering with a token that points at another machine makes both Relays
check they can reach each other; a firewall on either side fails `register`
with the address that could not be reached.

## Delivery

- **Claude** receives pushes over the Claude Code channel. The session must be
  started from a terminal with
  `claude --dangerously-load-development-channels server:relay`; sessions
  created in the desktop app silently drop pushes.
- **Codex** cannot be pushed to. Its `send` blocks until the reply arrives and
  returns it, giving up after 4 minutes (the Codex client abandons a tool call
  at 5) with a note; a newer `send` from the same session takes over the wait.
  When Codex is idle, gave up waiting, or ended the turn that called `send`
  (read from its own thread history), the message is opened in the Codex
  desktop app through a `codex://threads/<id>?prompt=` link and submitted; this
  needs the ChatGPT app and Accessibility permission for the app that launched
  Relay.

A message that reaches Codex while a turn is running normally waits behind
that turn. `send(..., urgent: true)` steers the running turn instead. Relay
reads the app's `followUpQueueMode` (queue, steer or interrupt) and
`composerEnterBehavior` from `~/.codex/config.toml`, checks in the thread's
rollout whether a turn is running, and submits with the key combination that
gives the wanted behavior for that one message: with Enter as the submit key,
Cmd+Return does the opposite of the configured follow-up mode; with Cmd+Enter
as the submit key, Cmd+Shift+Return does.

`relay doctor` lists these requirements; `register` reports only the ones that
fail on this machine.

## Run

```bash
npm install
relay serve                      # listens on 0.0.0.0:8765; tokens carry this machine's LAN address
relay serve --advertise 10.0.0.5 # when the detected address is not the one peers should use
relay doctor
relay status                     # registrations, bindings, connections, waiting sends (this machine only)
relay clear
```

Register the endpoints once per client:

```bash
claude mcp add --transport http --scope user relay http://127.0.0.1:8765/mcp/claude
codex  mcp add relay --url http://127.0.0.1:8765/mcp/codex
```

`status` and `clear` answer only from the machine Relay runs on; the peer
endpoints (`/peer/*`) accept requests only with a valid session token.
