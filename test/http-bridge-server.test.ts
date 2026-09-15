import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startBridgeHttpServer, type BridgeHttpServer, type BridgeHttpServerOptions } from "../src/http-bridge-server.ts";

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.unknown()),
  }),
});

type Received = { content: string; from: string; provider: string; role: string };

/** Host driver for tests: no real app, and every Codex turn is still running. */
const idleDesktop = {
  async open() {},
  async submit() {},
  async appInstalled() { return true; },
  async canSendKeystrokes() { return true; },
  async codexTurnEnded() { return false; },
  async codexFollowUpMode() { return "queue" as const; },
  async codexComposerEnterBehavior() { return "enter" as const; },
  async codexTurnRunning() { return false; },
};

type Keys = { command: boolean; shift: boolean };
const keys = (command: boolean, shift = false): Keys => ({ command, shift });

function startBridge(options: Partial<BridgeHttpServerOptions> = {}) {
  return startBridgeHttpServer({ host: "127.0.0.1", port: 0, advertise: "127.0.0.1", desktop: idleDesktop, ...options });
}

async function connect(bridge: BridgeHttpServer, provider: string, name = provider) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`/mcp/${provider}`, bridge.url)),
  );
  return client;
}

/** Queues every channel message pushed to this client; `next()` hands them out in arrival order. */
function channelMessages(client: Client): { next(what?: string): Promise<Received> } {
  const queue: Received[] = [];
  const waiters: Array<(r: Received) => void> = [];
  client.setNotificationHandler(ChannelNotificationSchema, (n) => {
    const received = {
      content: n.params.content,
      from: n.params.meta.from as string,
      provider: n.params.meta.provider as string,
      role: n.params.meta.role as string,
    };
    const waiter = waiters.shift();
    if (waiter) waiter(received);
    else queue.push(received);
  });
  return {
    next(what = "channel message") {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return within(new Promise<Received>((resolve) => waiters.push(resolve)), 1000, what);
    },
  };
}

/** Resolves with the next channel message pushed to this client. */
function nextChannelMessage(client: Client): Promise<Received> {
  return channelMessages(client).next();
}

/** Resolves with `promise`, or rejects after `ms` so a missing push fails the test instead of hanging it. */
function within<T>(promise: Promise<T>, ms = 1000, what = "promise"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

interface Registered {
  registered: boolean;
  sessionId: string;
  provider: string;
  role: string;
  token: string;
  bound: Array<{ sessionId: string; provider: string; role: string; address?: string }>;
  notified?: boolean;
  notifyError?: string;
  setupProblems?: Array<{ name: string; ok: boolean | null; fix: string }>;
}

/** Register and return the parsed result; throws on a tool error so tests fail at the cause. */
async function register(client: Client, sessionId: string, role: string, token?: string): Promise<Registered> {
  const result = await client.callTool({
    name: "register",
    arguments: { sessionId, role, ...(token === undefined ? {} : { token }) },
  });
  if (result.isError) throw new Error(`register failed: ${textOf(result)}`);
  return JSON.parse(textOf(result));
}

async function stateOf(bridge: BridgeHttpServer) {
  return (await fetch(new URL("/admin/state", bridge.url))).json();
}

test("a session registers, hands its token to a counterpart, and the two exchange messages", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushes = channelMessages(claude);

  try {
    const cl = await register(claude, "cl-1", "review");
    assert.match(cl.token, /^[A-Za-z0-9_-]{8}@127\.0\.0\.1:\d+$/);
    assert.deepEqual(cl.bound, []);

    const cx = await register(codex, "cx-1", "executor", cl.token);
    assert.notEqual(cx.token, cl.token);
    assert.deepEqual(cx.bound, [{ sessionId: "cl-1", provider: "claude", role: "review" }]);
    assert.match((await pushes.next("bind notice")).content, /^\[Relay\] executor \(codex, cx-1\) bound to you/);

    const sendPromise = codex.callTool({
      name: "send",
      arguments: { message: "What is 2+2?", selfSessionId: "cx-1", target: "claude", role: "review" },
    });
    assert.deepEqual(await pushes.next(), { content: "What is 2+2?", from: "cx-1", provider: "codex", role: "executor" });

    const reply = await claude.callTool({
      name: "send",
      arguments: { message: "4", selfSessionId: "cl-1", target: "codex" },
    });
    assert.equal(reply.isError, undefined);
    assert.equal(textOf(await sendPromise), "4");
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("registering again keeps the token; another token appends a binding", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codexA = await connect(bridge, "codex", "codex-a");
  const codexB = await connect(bridge, "codex", "codex-b");
  try {
    const cl = await register(claude, "cl-1", "architect");
    const a = await register(codexA, "cx-a", "executor");
    const b = await register(codexB, "cx-b", "tester");

    const again = await register(claude, "cl-1", "architect", a.token);
    assert.equal(again.token, cl.token);
    const third = await register(claude, "cl-1", "architect", b.token);
    assert.deepEqual(third.bound.map((x) => x.sessionId).sort(), ["cx-a", "cx-b"]);

    // Each Codex is bound to Claude only, not to each other.
    const state = await stateOf(bridge);
    const of = (id: string) => state.bindings.find((x: { sessionId: string }) => x.sessionId === id)?.counterparts.map((c: { sessionId: string }) => c.sessionId);
    assert.deepEqual(of("cx-a"), ["cl-1"]);
    assert.deepEqual(of("cx-b"), ["cl-1"]);

    const ambiguous = await claude.callTool({ name: "send", arguments: { message: "go", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(ambiguous.isError, true);
    assert.match(textOf(ambiguous), /Several bound codex sessions: cx-a, cx-b; pass one sessionId as target/);
  } finally {
    await Promise.allSettled([claude.close(), codexA.close(), codexB.close()]);
    await bridge.close();
  }
});

test("a role is unique among one owner's counterparts: a second binder with the same role is refused, other owners are unaffected", async () => {
  const bridge = await startBridge();
  const owner = await connect(bridge, "claude", "owner");
  const other = await connect(bridge, "claude", "other");
  const codexA = await connect(bridge, "codex", "codex-a");
  const codexB = await connect(bridge, "codex", "codex-b");
  try {
    const ow = await register(owner, "cl-1", "review");
    const ot = await register(other, "cl-2", "review");
    await register(codexA, "cx-a", "executor", ow.token);

    // Same role, same owner: refused, and cx-b stays registered but unbound.
    await register(codexB, "cx-b", "executor");
    const refused = await codexB.callTool({ name: "register", arguments: { sessionId: "cx-b", role: "executor", token: ow.token } });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), 'Role "executor" is already bound to cl-1 by session cx-a; register with another role');
    const state = await stateOf(bridge);
    assert.deepEqual(state.registrations.map((r: { sessionId: string }) => r.sessionId).sort(), ["cl-1", "cl-2", "cx-a", "cx-b"]);
    const of = (id: string) => state.bindings.find((x: { sessionId: string }) => x.sessionId === id)?.counterparts.map((c: { sessionId: string }) => c.sessionId) ?? [];
    assert.deepEqual(of("cl-1"), ["cx-a"]);
    assert.deepEqual(of("cx-b"), []);

    // Same role under a different owner is fine, and the owner side is checked too:
    // cx-a may not bind to a second owner whose role it already has bound.
    const elsewhere = await register(codexB, "cx-b", "executor", ot.token);
    assert.deepEqual(elsewhere.bound, [{ sessionId: "cl-2", provider: "claude", role: "review" }]);
    const twoReviews = await codexA.callTool({ name: "register", arguments: { sessionId: "cx-a", role: "executor", token: ot.token } });
    assert.equal(twoReviews.isError, true);
    assert.equal(textOf(twoReviews), 'Role "review" is already bound to cx-a by session cl-1; register with another role');

    // Re-binding the same pair is idempotent.
    const again = await register(codexA, "cx-a", "executor", ow.token);
    assert.deepEqual(again.bound, [{ sessionId: "cl-1", provider: "claude", role: "review" }]);
  } finally {
    await Promise.allSettled([owner.close(), other.close(), codexA.close(), codexB.close()]);
    await bridge.close();
  }
});

test("register needs a role: an empty role is refused and nothing is registered", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  try {
    const empty = await claude.callTool({ name: "register", arguments: { sessionId: "cl-1", role: "" } });
    assert.equal(empty.isError, true);
    assert.match(textOf(empty), /role/);
    assert.deepEqual((await stateOf(bridge)).registrations, []);
  } finally {
    await Promise.allSettled([claude.close()]);
    await bridge.close();
  }
});

test("binding with a token tells the token's owner who bound to it", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushed = nextChannelMessage(claude);
  try {
    const cl = await register(claude, "cl-1", "review");
    const cx = await register(codex, "cx-1", "executor", cl.token);
    assert.equal(cx.notified, true);
    assert.equal(cx.notifyError, undefined);
    assert.deepEqual(await within(pushed, 1000, "bind notice to claude"), {
      content: '[Relay] executor (codex, cx-1) bound to you with your token; reach it with send(role="executor").',
      from: "cx-1",
      provider: "codex",
      role: "executor",
    });
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("when the token's owner cannot be told, the binding still holds and the binder sees why", async () => {
  const bridge = await startBridge();
  const gemini = await connect(bridge, "gemini");
  const claude = await connect(bridge, "claude");
  try {
    const gm = await register(gemini, "gm-1", "review");
    const cl = await register(claude, "cl-1", "executor", gm.token);
    assert.deepEqual(cl.bound, [{ sessionId: "gm-1", provider: "gemini", role: "review" }]);
    assert.equal(cl.notified, false);
    assert.match(cl.notifyError ?? "", /gemini sessions cannot receive pushes/);

    const state = await stateOf(bridge);
    const of = (id: string) => state.bindings.find((x: { sessionId: string }) => x.sessionId === id)?.counterparts.map((c: { sessionId: string }) => c.sessionId);
    assert.deepEqual(of("cl-1"), ["gm-1"]);
    assert.deepEqual(of("gm-1"), ["cl-1"]);
  } finally {
    await Promise.allSettled([gemini.close(), claude.close()]);
    await bridge.close();
  }
});

test("bad tokens fail visibly at register", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  try {
    const cl = await register(claude, "cl-1", "review");
    const self = await claude.callTool({ name: "register", arguments: { sessionId: "cl-1", role: "review", token: cl.token } });
    assert.equal(self.isError, true);
    assert.match(textOf(self), /cannot bind to itself/);

    const unknown = await claude.callTool({ name: "register", arguments: { sessionId: "cl-1", role: "review", token: cl.token.replace(/^[^@]+/, "nope0000") } });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No session for token nope0000@/);

    const malformed = await claude.callTool({ name: "register", arguments: { sessionId: "cl-1", role: "review", token: "garbage" } });
    assert.equal(malformed.isError, true);
    assert.match(textOf(malformed), /Malformed token "garbage": expected secret@host:port/);
  } finally {
    await Promise.allSettled([claude.close()]);
    await bridge.close();
  }
});

test("send reaches a counterpart by role alone; target is not needed", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushes = channelMessages(claude);
  try {
    const cl = await register(claude, "cl-1", "review");
    await register(codex, "cx-1", "executor", cl.token);
    await pushes.next("bind notice");

    const pending = codex.callTool({ name: "send", arguments: { message: "ready?", selfSessionId: "cx-1", role: "review" } });
    assert.deepEqual(await pushes.next("push to claude"), { content: "ready?", from: "cx-1", provider: "codex", role: "executor" });

    const reply = await claude.callTool({ name: "send", arguments: { message: "go", selfSessionId: "cl-1", role: "executor" } });
    assert.deepEqual(JSON.parse(textOf(reply)), { sent: true });
    assert.equal(textOf(await pending), "go");
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("codex send waits for the reply while claude send returns at once", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushes = channelMessages(claude);
  try {
    const cl = await register(claude, "cl-1", "review");
    await register(codex, "cx-1", "executor", cl.token);
    await pushes.next("bind notice");
    const pending = codex.callTool({ name: "send", arguments: { message: "q", selfSessionId: "cx-1", target: "claude" } });
    assert.equal((await pushes.next()).content, "q");
    assert.deepEqual((await stateOf(bridge)).waiting, ["cx-1"]);

    const reply = await claude.callTool({ name: "send", arguments: { message: "a", selfSessionId: "cl-1", target: "codex" } });
    assert.deepEqual(JSON.parse(textOf(reply)), { sent: true });
    assert.equal(textOf(await pending), "a");
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("every provider gets the same tools and any provider name is accepted; only codex is told how to wait cheaply", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const gemini = await connect(bridge, "gemini");
  const codex = await connect(bridge, "codex");
  try {
    const expected = ["register", "send", "unregister"];
    assert.deepEqual((await claude.listTools()).tools.map((t) => t.name).sort(), expected);
    assert.deepEqual((await gemini.listTools()).tools.map((t) => t.name).sort(), expected);
    assert.deepEqual((await codex.listTools()).tools.map((t) => t.name).sort(), expected);

    // Codex polls a yielded exec cell with full-context model calls, so its instructions pin a long yield.
    assert.match(codex.getInstructions() ?? "", /"yield_time_ms": 240000/);
    assert.match(codex.getInstructions() ?? "", /Never poll it with short waits or sleep loops/);
    assert.doesNotMatch(claude.getInstructions() ?? "", /yield_time_ms/);
  } finally {
    await Promise.allSettled([claude.close(), gemini.close(), codex.close()]);
    await bridge.close();
  }
});

test("send without a binding fails visibly", async () => {
  const bridge = await startBridge();
  const codex = await connect(bridge, "codex");
  try {
    await register(codex, "cx-1", "executor");
    const result = await codex.callTool({ name: "send", arguments: { message: "hi", selfSessionId: "cx-1", target: "claude", role: "review" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No bound claude session with role "review"; register with its token first/);

    const byRole = await codex.callTool({ name: "send", arguments: { message: "hi", selfSessionId: "cx-1", role: "review" } });
    assert.equal(byRole.isError, true);
    assert.match(textOf(byRole), /No bound session with role "review"; register with its token first/);

    const neither = await codex.callTool({ name: "send", arguments: { message: "hi", selfSessionId: "cx-1" } });
    assert.equal(neither.isError, true);
    assert.match(textOf(neither), /target or role is required/);
  } finally {
    await Promise.allSettled([codex.close()]);
    await bridge.close();
  }
});

test("a session that drops without DELETE keeps its registration and bindings; re-register restores delivery", async () => {
  const bridge = await startBridge({ disconnectGraceMs: 50 });
  const claude1 = await connect(bridge, "claude", "claude-1");
  const codex = await connect(bridge, "codex");
  let claude2: Client | undefined;
  try {
    const cl = await register(claude1, "cl-1", "review");
    await register(codex, "cx-1", "executor", cl.token);
    const first = nextChannelMessage(claude1);
    const pending1 = codex.callTool({ name: "send", arguments: { message: "one", selfSessionId: "cx-1", target: "claude" } });
    await first;

    await claude1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    claude2 = await connect(bridge, "claude", "claude-2");
    const second = nextChannelMessage(claude2);
    const back = await register(claude2, "cl-1", "review");
    assert.equal(back.token, cl.token);
    assert.deepEqual(back.bound.map((b) => b.sessionId), ["cx-1"]);
    await claude2.callTool({ name: "send", arguments: { message: "ack one", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(textOf(await pending1), "ack one");

    const pending2 = codex.callTool({ name: "send", arguments: { message: "two", selfSessionId: "cx-1", target: "claude" } });
    assert.equal((await second).content, "two");
    await claude2.callTool({ name: "send", arguments: { message: "ack two", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(textOf(await pending2), "ack two");
  } finally {
    await Promise.allSettled([claude2?.close(), codex.close()]);
    await bridge.close();
  }
});

test("unregister drops the binding and fails the waiting counterpart", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushes = channelMessages(claude);
  try {
    const cl = await register(claude, "cl-1", "review");
    await register(codex, "cx-1", "executor", cl.token);
    await pushes.next("bind notice");
    const pending = codex.callTool({ name: "send", arguments: { message: "one", selfSessionId: "cx-1", target: "claude" } });
    assert.equal((await pushes.next()).content, "one");

    const left = await claude.callTool({ name: "unregister", arguments: { sessionId: "cl-1" } });
    assert.deepEqual(JSON.parse(textOf(left)), { unregistered: true, sessionId: "cl-1" });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Counterpart unregistered: cl-1/);

    const again = await codex.callTool({ name: "send", arguments: { message: "two", selfSessionId: "cx-1", target: "claude" } });
    assert.equal(again.isError, true);
    assert.match(textOf(again), /No bound claude session; register with its token first/);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("admin endpoints expose and clear the relay state", async () => {
  const bridge = await startBridge();
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushes = channelMessages(claude);
  const admin = new URL("/admin/state", bridge.url);
  try {
    const cl = await register(claude, "cl-1", "review");
    await register(codex, "cx-1", "executor", cl.token);
    await pushes.next("bind notice");
    const pending = codex.callTool({ name: "send", arguments: { message: "one", selfSessionId: "cx-1", target: "claude" } });
    assert.equal((await pushes.next()).content, "one");

    const state = await (await fetch(admin)).json();
    assert.equal(state.server.url, bridge.url.toString());
    assert.equal(state.server.advertise, `127.0.0.1:${bridge.url.port}`);
    assert.equal(state.server.pid, process.pid);
    assert.deepEqual(state.server.mcpSessions.map((m: { provider: string }) => m.provider).sort(), ["claude", "codex"]);
    assert.deepEqual(state.registrations.map((r: { sessionId: string; token: string }) => [r.sessionId, r.token]).sort(), [["cl-1", cl.token], ["cx-1", (await stateOf(bridge)).registrations.find((r: { sessionId: string }) => r.sessionId === "cx-1").token]]);
    assert.deepEqual(state.waiting, ["cx-1"]);
    assert.equal(state.bindings.length, 2);

    const cleared = await (await fetch(admin, { method: "DELETE" })).json();
    assert.deepEqual(cleared, { cleared: true, registrations: 2 });
    assert.equal((await pending).isError, true);

    const { server: _server, ...after } = await (await fetch(admin)).json();
    assert.deepEqual(after, { registrations: [], bindings: [], connected: [], waiting: [] });
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("a late register on a claude transport is answered 404 once so Claude Code re-initializes", async () => {
  const bridge = await startBridge({ claudeReinitAfterMs: 50 });
  const stale = await connect(bridge, "claude", "stale");
  let fresh: Client | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(
      stale.callTool({ name: "register", arguments: { sessionId: "cl-1", role: "review" } }),
      /Session reset so the client re-initializes/,
    );
    fresh = await connect(bridge, "claude", "fresh");
    await register(fresh, "cl-1", "review");
    const state = await stateOf(bridge);
    assert.deepEqual(state.connected, ["cl-1"]);
    assert.equal(state.server.mcpSessions.length, 1);
  } finally {
    await Promise.allSettled([stale.close(), fresh?.close()]);
    await bridge.close();
  }
});

test("when a registered transport closes, the one fresh unregistered transport inherits the registration", async () => {
  const bridge = await startBridge({ disconnectGraceMs: 50 });
  const throwaway = await connect(bridge, "claude", "throwaway");
  const codex = await connect(bridge, "codex");
  let replacement: Client | undefined;
  try {
    const cl = await register(throwaway, "cl-1", "review");
    await register(codex, "cx-1", "executor", cl.token);

    replacement = await connect(bridge, "claude", "replacement");
    const pushed = nextChannelMessage(replacement);
    await throwaway.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual((await stateOf(bridge)).connected.sort(), ["cl-1", "cx-1"]);
    const pending = codex.callTool({ name: "send", arguments: { message: "hello heir", selfSessionId: "cx-1", target: "claude" } });
    assert.equal((await pushed).content, "hello heir");
    await replacement.callTool({ name: "send", arguments: { message: "inherited", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(textOf(await pending), "inherited");
  } finally {
    await Promise.allSettled([replacement?.close(), codex.close()]);
    await bridge.close();
  }
});

test("a message to an idle codex session is delivered through the codex:// deep link and submitted", async () => {
  const calls: string[] = [];
  const desktop = {
    ...idleDesktop,
    async open(url: string) { calls.push(`open ${url}`); },
    async submit(app: string, k: Keys) { calls.push(`submit ${app} command=${k.command} shift=${k.shift}`); },
  };
  const bridge = await startBridge({ desktop });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  try {
    const cl = await register(claude, "cl-1", "architect");
    await register(codex, "thread-42", "executor", cl.token);
    const result = await claude.callTool({
      name: "send",
      arguments: { message: "please implement the login page", selfSessionId: "cl-1", target: "codex" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 2);
    const url = new URL(calls[0].replace("open ", ""));
    assert.equal(url.protocol, "codex:");
    assert.equal(url.host, "threads");
    assert.equal(url.pathname, "/thread-42");
    const prompt = url.searchParams.get("prompt") ?? "";
    assert.match(prompt, /^\[Relay\] from claude \(role "architect"\)\. Reply with send\(target="claude", role="architect"\)\./);
    assert.match(prompt, /please implement the login page$/);
    assert.equal(calls[1], "submit ChatGPT command=false shift=false");
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("the submit keys follow Codex's Enter setting, whether a turn is running, its follow-up mode and urgency", async () => {
  const submits: Keys[] = [];
  let mode: "queue" | "steer" | "interrupt" = "queue";
  let enter: "enter" | "cmdIfMultiline" | "cmdAlways" = "enter";
  let running = false;
  const desktop = {
    ...idleDesktop,
    async submit(_app: string, k: Keys) { submits.push(k); },
    async codexFollowUpMode() { return mode; },
    async codexComposerEnterBehavior() { return enter; },
    async codexTurnRunning(threadId: string) { return threadId === "thread-42" && running; },
  };
  const bridge = await startBridge({ desktop });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  try {
    const cl = await register(claude, "cl-1", "architect");
    await register(codex, "thread-42", "executor", cl.token);
    const send = async (urgent: boolean) => {
      const r = await claude.callTool({ name: "send", arguments: { message: "stop, wrong file", selfSessionId: "cl-1", target: "codex", urgent } });
      assert.equal(r.isError, undefined);
      return submits.pop();
    };
    // Enter submits (the app default). Idle: plain Return, urgency is moot.
    for (const m of ["queue", "steer", "interrupt"] as const) {
      mode = m;
      assert.deepEqual(await send(true), keys(false));
      assert.deepEqual(await send(false), keys(false));
    }
    // A turn is running: Cmd+Return does the opposite of the configured mode.
    running = true;
    mode = "queue";
    assert.deepEqual(await send(true), keys(true), "queue mode, urgent: invert to steer");
    assert.deepEqual(await send(false), keys(false), "queue mode, not urgent: queue as configured");
    for (const m of ["steer", "interrupt"] as const) {
      mode = m;
      assert.deepEqual(await send(true), keys(false), `${m} mode, urgent: as configured`);
      assert.deepEqual(await send(false), keys(true), `${m} mode, not urgent: invert to queue`);
    }
    // Cmd+Enter submits: the inverse is Cmd+Shift+Return, and idle submits need Cmd too.
    for (const e of ["cmdIfMultiline", "cmdAlways"] as const) {
      enter = e;
      running = false;
      assert.deepEqual(await send(true), keys(true, false));
      running = true;
      mode = "queue";
      assert.deepEqual(await send(true), keys(true, true));
      assert.deepEqual(await send(false), keys(true, false));
      mode = "steer";
      assert.deepEqual(await send(false), keys(true, true));
    }
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("when the desktop cannot submit, send fails visibly but says the message is in the composer", async () => {
  const desktop = {
    ...idleDesktop,
    async submit() { throw new Error("osascript is not allowed to send keystrokes"); },
    async canSendKeystrokes() { return false; },
  };
  const bridge = await startBridge({ desktop });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  try {
    const cl = await register(claude, "cl-1", "architect");
    await register(codex, "thread-42", "executor", cl.token);
    const result = await claude.callTool({ name: "send", arguments: { message: "task", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /in the Codex composer for thread thread-42 but was not submitted: osascript is not allowed/);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("register reports only failing setup checks, with fixes", async () => {
  const desktop = { ...idleDesktop, async canSendKeystrokes() { return false; } };
  const bridge = await startBridge({ desktop });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  try {
    const cl = await register(claude, "cl-1", "review");
    assert.equal("setupProblems" in cl, false);
    const cx = await register(codex, "t-1", "executor");
    assert.equal(cx.setupProblems?.length, 1);
    assert.equal(cx.setupProblems?.[0].name, "Accessibility permission for the app that launched Relay");
    assert.equal(cx.setupProblems?.[0].ok, false);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("an unknown session ID gets 404 so the client re-initializes", async () => {
  const bridge = await startBridge();
  try {
    const response = await fetch(new URL("/mcp/claude", bridge.url), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "stale" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 404);
  } finally {
    await bridge.close();
  }
});

test("a reply that comes after codex ended the turn that called send goes through the deep link", async () => {
  const calls: string[] = [];
  let turnEnded = false;
  const desktop = {
    ...idleDesktop,
    async open(url: string) { calls.push(url); },
    async codexTurnEnded(threadId: string) { return threadId === "thread-42" && turnEnded; },
  };
  const bridge = await startBridge({ desktop });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  try {
    const pushes = channelMessages(claude);
    const cl = await register(claude, "cl-1", "architect");
    await register(codex, "thread-42", "executor", cl.token);
    await pushes.next("bind notice");

    const blocked = codex.callTool({ name: "send", arguments: { message: "how should retry work?", selfSessionId: "thread-42", target: "claude" } });
    assert.equal((await pushes.next()).content, "how should retry work?");

    turnEnded = true;
    const reply = await claude.callTool({ name: "send", arguments: { message: "bound retries to the new candidate", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(reply.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]).pathname, "/thread-42");
    assert.match(textOf(await blocked), /^\[Relay\] The reply arrived after you stopped reading this send/);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("a codex send gives up waiting at the relay's limit, before the codex client's own timeout", async () => {
  const opens: string[] = [];
  const bridge = await startBridge({ waitLimitMs: 100, desktop: { ...idleDesktop, async open(url: string) { opens.push(url); } } });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  try {
    const pushes = channelMessages(claude);
    const cl = await register(claude, "cl-1", "architect");
    await register(codex, "thread-42", "executor", cl.token);
    await pushes.next("bind notice");
    const result = await codex.callTool({ name: "send", arguments: { message: "committed 7963322", selfSessionId: "thread-42", target: "claude" } });
    assert.equal((await pushes.next()).content, "committed 7963322");
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /^\[Relay\] No reply within 0 seconds/);
    assert.deepEqual((await stateOf(bridge)).waiting, []);
    const late = await claude.callTool({ name: "send", arguments: { message: "noted", selfSessionId: "cl-1", target: "codex" } });
    assert.equal(late.isError, undefined);
    assert.equal(opens.length, 1);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

// ---- two relays -------------------------------------------------------------------

test("a session binds to a session on another relay with its token; messages flow both ways", async () => {
  const opens: string[] = [];
  const submits: Keys[] = [];
  const relayA = await startBridge();
  const relayB = await startBridge({
    desktop: {
      ...idleDesktop,
      async open(url: string) { opens.push(url); },
      async submit(_app: string, k: Keys) { submits.push(k); },
    },
  });
  const claude = await connect(relayA, "claude");
  const codex = await connect(relayB, "codex");
  const pushes = channelMessages(claude);
  try {
    const cl = await register(claude, "cl-1", "architect");
    const cx = await register(codex, "cx-1", "executor", cl.token);
    assert.deepEqual(cx.bound, [{ sessionId: "cl-1", provider: "claude", role: "architect", address: `http://127.0.0.1:${relayA.url.port}` }]);
    // The owner on relay A is told about the binding made from relay B.
    assert.equal(cx.notified, true);
    assert.deepEqual(await pushes.next("bind notice across relays"), {
      content: '[Relay] executor (codex, cx-1) bound to you with your token; reach it with send(role="executor").',
      from: "cx-1",
      provider: "codex",
      role: "executor",
    });
    const onA = (await stateOf(relayA)).bindings.find((b: { sessionId: string }) => b.sessionId === "cl-1");
    assert.deepEqual(onA.counterparts, [{ sessionId: "cx-1", provider: "codex", role: "executor", address: `http://127.0.0.1:${relayB.url.port}` }]);

    // Codex asks; Claude on the other relay gets the push and its answer returns from Codex's send.
    const pending = codex.callTool({ name: "send", arguments: { message: "which retry policy?", selfSessionId: "cx-1", target: "claude", role: "architect" } });
    assert.deepEqual(await pushes.next(), { content: "which retry policy?", from: "cx-1", provider: "codex", role: "executor" });
    assert.deepEqual((await stateOf(relayB)).waiting, ["cx-1"]);
    const reply = await claude.callTool({ name: "send", arguments: { message: "exponential, max 3", selfSessionId: "cl-1", target: "codex", role: "executor" } });
    assert.equal(reply.isError, undefined);
    assert.equal(textOf(await pending), "exponential, max 3");

    // Claude assigns work while Codex is idle: the deep link opens on Codex's machine, urgency included.
    const assigned = await claude.callTool({ name: "send", arguments: { message: "implement it", selfSessionId: "cl-1", target: "codex", urgent: true } });
    assert.equal(assigned.isError, undefined);
    assert.equal(opens.length, 1);
    assert.match(decodeURIComponent(opens[0]), /from claude \(role "architect"\)[\s\S]*implement it$/);
    assert.deepEqual(submits, [keys(false)]);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await Promise.allSettled([relayA.close(), relayB.close()]);
  }
});

test("a remote binder with a role the owner already has bound is refused; nothing is bound on either side", async () => {
  const relayA = await startBridge();
  const relayB = await startBridge();
  const claude = await connect(relayA, "claude");
  const local = await connect(relayA, "codex", "codex-local");
  const remote = await connect(relayB, "codex", "codex-remote");
  try {
    const cl = await register(claude, "cl-1", "architect");
    await register(local, "cx-local", "executor", cl.token);

    const refused = await remote.callTool({ name: "register", arguments: { sessionId: "cx-remote", role: "executor", token: cl.token } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /Role "executor" is already bound to cl-1 by session cx-local; register with another role/);

    const onA = (await stateOf(relayA)).bindings.find((b: { sessionId: string }) => b.sessionId === "cl-1");
    assert.deepEqual(onA.counterparts.map((c: { sessionId: string }) => c.sessionId), ["cx-local"]);
    assert.deepEqual((await stateOf(relayB)).bindings, []);

    // A binder already holding the owner's role from another owner is refused too, and the owner's side is rolled back.
    const other = await connect(relayB, "claude", "claude-b");
    try {
      const ot = await register(other, "cl-b", "architect");
      await register(remote, "cx-remote", "worker", ot.token);
      const twice = await remote.callTool({ name: "register", arguments: { sessionId: "cx-remote", role: "worker", token: cl.token } });
      assert.equal(twice.isError, true);
      assert.match(textOf(twice), /Role "architect" is already bound to cx-remote by session cl-b; register with another role/);
      const onAAfter = (await stateOf(relayA)).bindings.find((b: { sessionId: string }) => b.sessionId === "cl-1");
      assert.deepEqual(onAAfter.counterparts.map((c: { sessionId: string }) => c.sessionId), ["cx-local"]);
    } finally {
      await other.close();
    }
  } finally {
    await Promise.allSettled([claude.close(), local.close(), remote.close()]);
    await Promise.allSettled([relayA.close(), relayB.close()]);
  }
});

test("unregister on one relay drops the binding on the other and fails its waiting send", async () => {
  const relayA = await startBridge();
  const relayB = await startBridge();
  const claude = await connect(relayA, "claude");
  const codex = await connect(relayB, "codex");
  try {
    const cl = await register(claude, "cl-1", "architect");
    await register(codex, "cx-1", "executor", cl.token);
    const pushed = nextChannelMessage(claude);
    const pending = codex.callTool({ name: "send", arguments: { message: "q", selfSessionId: "cx-1", target: "claude" } });
    await pushed;

    const left = await claude.callTool({ name: "unregister", arguments: { sessionId: "cl-1" } });
    assert.deepEqual(JSON.parse(textOf(left)), { unregistered: true, sessionId: "cl-1" });
    assert.match(textOf(await pending), /Counterpart unregistered: cl-1/);
    assert.deepEqual((await stateOf(relayB)).bindings, []);
    const again = await codex.callTool({ name: "send", arguments: { message: "q", selfSessionId: "cx-1", target: "claude" } });
    assert.match(textOf(again), /No bound claude session; register with its token first/);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await Promise.allSettled([relayA.close(), relayB.close()]);
  }
});

test("binding to a relay that cannot be reached, or that cannot call back, fails at register with the address", async () => {
  const relayA = await startBridge();
  const relayB = await startBridge({ advertise: "127.0.0.1:1" });
  const claude = await connect(relayA, "claude");
  const codex = await connect(relayB, "codex");
  try {
    const dead = await claude.callTool({ name: "register", arguments: { sessionId: "cl-1", role: "architect", token: "abcdefgh@127.0.0.1:1" } });
    assert.equal(dead.isError, true);
    assert.match(textOf(dead), /Cannot reach the relay at 127\.0\.0\.1:1/);

    const cl = await register(claude, "cl-1", "architect");
    const wrong = await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", role: "executor", token: cl.token.replace(/^[^@]+/, "wrong000") } });
    assert.equal(wrong.isError, true);
    assert.match(textOf(wrong), /No session for token wrong000@/);

    // Relay B advertises a port nobody listens on, so A's call-back fails and the binding is refused.
    const noCallback = await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", role: "executor", token: cl.token } });
    assert.equal(noCallback.isError, true);
    assert.match(textOf(noCallback), /cannot reach this relay at 127\.0\.0\.1:1 .*firewall/);
    assert.deepEqual((await stateOf(relayA)).bindings, []);
    assert.deepEqual((await stateOf(relayB)).bindings, []);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await Promise.allSettled([relayA.close(), relayB.close()]);
  }
});

test("peer endpoints refuse deliveries that carry no valid token or come from an unbound session", async () => {
  const relayA = await startBridge();
  const claude = await connect(relayA, "claude");
  try {
    const cl = await register(claude, "cl-1", "architect");
    const post = (path: string, body: unknown) =>
      fetch(new URL(path, relayA.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const badToken = await post("/peer/deliver", { token: "nope@x:1", target: "cl-1", from: { sessionId: "cx-1", provider: "codex", role: "" }, message: "hi" });
    assert.equal(badToken.status, 404);
    const unbound = await post("/peer/deliver", { token: cl.token, target: "cl-1", from: { sessionId: "cx-1", provider: "codex", role: "" }, message: "hi" });
    assert.equal(unbound.status, 403);
    assert.match((await unbound.json()).error, /cx-1 is not bound to cl-1/);
  } finally {
    await Promise.allSettled([claude.close()]);
    await relayA.close();
  }
});
