# Relay

Let AI coding sessions talk to each other. A Claude Code session can hand work
to a Codex desktop thread, get its report back, review it, and interrupt it
when something urgent comes up; the sessions can sit on one Mac or on several
machines in the same LAN.

Typical shape: one Claude session acts as architect and coordinates several
Codex threads (executors, a fixer, a deployer), each in its own worktree. The
architect assigns, the executors report, the architect reviews and approves.
Every message is visible in the session that receives it.

## What it looks like

```text
Claude   register("cl-1", "architect")                      → token k8f3ab2c@192.168.0.107:8765
Codex    register("thread-42", "executor", "k8f3ab2c@…")     → bound to cl-1
Codex    send("Batch 2 done, please review", "thread-42", "claude", "architect")
           …blocks until the architect answers…
Claude   send("Approved. Commit to main, no push.", "cl-1", "codex", "executor")
           → returns from Codex's send
Claude   send("Stop: wrong file", "cl-1", "codex", "executor", urgent=true)
           → steers Codex's running turn instead of queueing behind it
```

Three MCP tools, identical for every provider:

```text
register(sessionId, role, token?)   → { token, bound: [...] }
send(message, selfSessionId, target, role?, urgent?)
unregister(sessionId)
```

## Quick start

Requirements: macOS, Node.js 24+, Claude Code, the ChatGPT desktop app with
Codex.

```bash
git clone https://github.com/gWcyWoo/relay.git && cd relay
npm install && npm link
relay doctor          # what this machine still needs, with the fix for each item
relay serve           # http://0.0.0.0:8765; tokens carry this machine's LAN address
```

Register the endpoints once per client:

```bash
claude mcp add --transport http --scope user relay http://127.0.0.1:8765/mcp/claude
codex  mcp add relay --url http://127.0.0.1:8765/mcp/codex
```

Start the Claude session from a terminal so it can receive pushes:

```bash
claude --dangerously-load-development-channels server:relay
```

Then, in that session: "register as architect". Copy the token it prints into
a Codex thread: "register as executor with token …". They are bound; from here
on both just `send`.

## How sessions find each other

A registered session gets a **token** (`secret@host:port`): its address, valid
as long as it stays registered and unchanged across reconnects. Hand it to
another session and let that session `register` with it; the two are now
**bound**, on both sides. Each further token adds one more binding, so an
architect can be bound to a local Codex and to two Codex threads on other
machines at once. Tokens never appear in `send`: bound counterparts are
addressed by provider and role, or by sessionId when two share a role.

When the token points at another machine, the two Relays bind over HTTP and
call each other back first; a firewall on either side fails `register` with
the address that could not be reached. Messages between machines are forwarded
with the target's token, and only with it.

## How delivery works

- **Claude** receives pushes over the Claude Code channel, so its `send`
  returns at once. Sessions created in the desktop app cannot receive pushes;
  start them from the terminal as shown above.
- **Codex** cannot be pushed to. Its `send` blocks until the reply arrives and
  returns it, giving up after 4 minutes with a note (the Codex client abandons
  a tool call at 5). When Codex is idle, gave up waiting, or ended the turn
  that called `send`, the message is opened in the Codex desktop app through a
  `codex://threads/<id>?prompt=` link and submitted with a keystroke.
- **Urgent messages.** A message that reaches a running Codex turn normally
  waits behind it. `urgent: true` steers the running turn instead: Relay reads
  the app's follow-up mode and Enter setting from `~/.codex/config.toml`,
  checks the thread's rollout for an open turn, and presses Return,
  Cmd+Return or Cmd+Shift+Return, whichever the app maps to the wanted
  behavior for that one message.

## Commands

```bash
relay serve  [--host 0.0.0.0] [--port 8765] [--advertise <host[:port]>]
relay doctor                       # each provider's requirements on this machine
relay status [--url …]             # registrations, bindings, connections, waiting sends
relay clear  [--url …]             # drop everything; waiting sends get an error
```

`status` and `clear` answer only from the machine Relay runs on.

## Known limits

- Codex delivery drives the desktop app: it needs the ChatGPT app, the
  `codex://` scheme, and Accessibility permission for the app that launched
  Relay (Terminal, usually). Codex CLI sessions can only receive while they
  are blocked in `send`.
- Relay reads Codex's own files to know a thread's state
  (`~/.codex/thread_history_1.sqlite`, `state_5.sqlite`, rollout files) and
  the key handling was taken from the desktop app's bundle. A Codex update
  can change any of these; `relay doctor` and `register` report what no
  longer works instead of guessing.
- Claude Code's channel support is behind a development flag and may change.
- No persistence: restarting Relay drops registrations and bindings; sessions
  register again and exchange tokens again.

## Development

```bash
npm test          # node --test, no network beyond 127.0.0.1
npm run typecheck
```
