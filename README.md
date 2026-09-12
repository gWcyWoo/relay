# Relay

**[中文](#中文) / [ENGLISH](#english)**

---

## 中文

让 AI 编码会话之间互相对话。一个 Claude Code 会话可以把任务派给 Codex 桌面端的线程,收它的汇报,做复审,有急事时打断它;这些会话可以在同一台 Mac 上,也可以分布在同一局域网的多台机器上。

典型用法:一个 Claude 会话担任架构师,协调多个 Codex 线程(执行者、修复者、部署者),各自在自己的工作树里干活。架构师派活,执行者汇报,架构师复审、批准。每条消息在接收方的会话里都完整可见。

### 长什么样

```text
Claude   register("cl-1", "architect")                      → token k8f3ab2c@192.168.0.107:8765
Codex    register("thread-42", "executor", "k8f3ab2c@…")     → 与 cl-1 绑定
Codex    send("第二批完成,请复审", "thread-42", "claude", "architect")
           …阻塞,直到架构师回复…
Claude   send("通过。提交到本地 main,不推送。", "cl-1", "codex", "executor")
           → 作为 Codex 那次 send 的返回值送达
Claude   send("停:改错文件了", "cl-1", "codex", "executor", urgent=true)
           → 插入 Codex 正在运行的回合,而不是排在后面
```

三个 MCP 工具,所有 provider 完全一样:

```text
register(sessionId, role, token?)   → { token, bound: [...] }
send(message, selfSessionId, target, role?, urgent?)
unregister(sessionId)
```

### 快速开始

需要:macOS、Node.js 24+、Claude Code、带 Codex 的 ChatGPT 桌面应用。

```bash
git clone https://github.com/gWcyWoo/relay.git && cd relay
npm install && npm link
relay doctor          # 这台机器还缺什么,每一项附修复方法
relay serve           # http://0.0.0.0:8765;token 带的是本机局域网地址
```

每个客户端配一次端点:

```bash
claude mcp add --transport http --scope user relay http://127.0.0.1:8765/mcp/claude
codex  mcp add relay --url http://127.0.0.1:8765/mcp/codex
```

Claude 会话要从终端启动,才能收到推送:

```bash
claude --dangerously-load-development-channels server:relay
```

然后在这个会话里说"以架构师身份注册",把它打印的 token 复制到一个 Codex 线程里:"以执行者身份注册,token 是 …"。两边就绑定了,之后各自 `send` 即可。

### 会话怎么找到彼此

会话注册后拿到一个 **token**(`secret@host:port`):它就是这个会话的地址,注册期间一直有效,断线重连也不变。把它交给另一个会话,让那个会话带着它 `register`,两者就**绑定**了,双方表里都有对方。每多一个 token 就多一条绑定,所以一个架构师可以同时绑本机的 Codex 和另外两台机器上的 Codex。token 不出现在 `send` 里:发消息按 provider 和 role 找绑定的对方,两个对方 role 相同时用 sessionId 指定。

token 指向另一台机器时,两台 Relay 之间通过 HTTP 绑定,并且先互相回连确认;任何一侧有防火墙,`register` 直接失败并写明连不上的地址。跨机器的消息带着目标会话的 token 转发,没有 token 一律拒绝。

### 消息怎么送达

- **Claude** 通过 Claude Code 的 channel 收推送,所以它的 `send` 立即返回。桌面应用里创建的会话收不到推送,请按上面的方式从终端启动。
- **Codex** 无法被推送。它的 `send` 会阻塞到回复到达并把回复返回,4 分钟没回复就返回一句说明(Codex 客户端会在 5 分钟时放弃工具调用)。Codex 空闲、已放弃等待、或已结束调用 `send` 的那个回合时,消息通过 `codex://threads/<id>?prompt=` 深链接打开 Codex 桌面端并用按键提交。
- **紧急消息。** 消息到达时 Codex 正在跑回合,默认排在后面。`urgent: true` 会插入当前回合:Relay 从 `~/.codex/config.toml` 读取应用的 follow-up 模式和 Enter 设置,从线程的 rollout 判断是否有回合在跑,然后按 Return、Cmd+Return 或 Cmd+Shift+Return 中能得到目标行为的那个组合。

### 命令

```bash
relay serve  [--host 0.0.0.0] [--port 8765] [--advertise <host[:port]>]
relay doctor                       # 各 provider 在本机的依赖项
relay status [--url …]             # 注册、绑定、连接、等待中的 send
relay clear  [--url …]             # 清空全部;等待中的 send 收到错误
```

`status` 和 `clear` 只在运行 Relay 的机器上可用。

### 已知限制

- 给 Codex 投递靠驱动桌面应用:需要 ChatGPT 应用、`codex://` 协议、以及给启动 Relay 的应用(通常是终端)开辅助功能权限。Codex CLI 会话只有阻塞在 `send` 里时才能收到消息。
- Relay 读取 Codex 自己的文件来判断线程状态(`~/.codex/thread_history_1.sqlite`、`state_5.sqlite`、rollout 文件),按键规则取自桌面应用的包。Codex 升级可能改变其中任何一项;`relay doctor` 和 `register` 会报告失效的项,不猜。
- Claude Code 的 channel 在开发标志之后,可能变化。
- 不持久化:Relay 重启后注册和绑定全部丢失,会话需要重新注册、重新交换 token。

### 开发

```bash
npm test          # node --test,只用 127.0.0.1
npm run typecheck
```

---

## ENGLISH

Let AI coding sessions talk to each other. A Claude Code session can hand work
to a Codex desktop thread, get its report back, review it, and interrupt it
when something urgent comes up; the sessions can sit on one Mac or on several
machines in the same LAN.

Typical shape: one Claude session acts as architect and coordinates several
Codex threads (executors, a fixer, a deployer), each in its own worktree. The
architect assigns, the executors report, the architect reviews and approves.
Every message is visible in the session that receives it.

### What it looks like

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

### Quick start

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

### How sessions find each other

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

### How delivery works

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

### Commands

```bash
relay serve  [--host 0.0.0.0] [--port 8765] [--advertise <host[:port]>]
relay doctor                       # each provider's requirements on this machine
relay status [--url …]             # registrations, bindings, connections, waiting sends
relay clear  [--url …]             # drop everything; waiting sends get an error
```

`status` and `clear` answer only from the machine Relay runs on.

### Known limits

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

### Development

```bash
npm test          # node --test, no network beyond 127.0.0.1
npm run typecheck
```
