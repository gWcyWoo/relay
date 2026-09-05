import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { startBridgeHttpServer, type BridgeHttpServer } from "../src/http-bridge-server.ts";

const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.unknown()),
  }),
});

type Received = { content: string; from: string; provider: string; role: string };

async function connect(bridge: BridgeHttpServer, provider: string, name = provider) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`/mcp/${provider}`, bridge.url)),
  );
  return client;
}

/** Resolves with the next channel message pushed to this client. */
function nextChannelMessage(client: Client): Promise<Received> {
  return new Promise((resolve) => {
    client.setNotificationHandler(ChannelNotificationSchema, (n) => {
      resolve({
        content: n.params.content,
        from: n.params.meta.from as string,
        provider: n.params.meta.provider as string,
        role: n.params.meta.role as string,
      });
    });
  });
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

test("Codex sends with target, Claude gets a channel push and answers with send", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushed = nextChannelMessage(claude);

  try {
    await claude.callTool({
      name: "register",
      arguments: { sessionId: "cl-1", path: "/projects/test", role: "review" },
    });
    await codex.callTool({
      name: "register",
      arguments: { sessionId: "cx-1", path: "/projects/test" },
    });

    const sendPromise = codex.callTool({
      name: "send",
      arguments: { message: "What is 2+2?", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });

    assert.deepEqual(await pushed, { content: "What is 2+2?", from: "cx-1", provider: "codex", role: "review" });

    const reply = await claude.callTool({
      name: "send",
      arguments: { message: "4", selfSessionId: "cl-1", target: "codex", role: "review" },
    });
    assert.equal(reply.isError, undefined);

    const result = await sendPromise;
    assert.equal(result.isError, undefined);
    assert.equal(textOf(result), "4");
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("every provider gets the same tools and any provider name is accepted", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const claude = await connect(bridge, "claude");
  const gemini = await connect(bridge, "gemini");
  try {
    const expected = ["register", "send", "unregister"];
    assert.deepEqual((await claude.listTools()).tools.map((t) => t.name).sort(), expected);
    assert.deepEqual((await gemini.listTools()).tools.map((t) => t.name).sort(), expected);
  } finally {
    await Promise.allSettled([claude.close(), gemini.close()]);
    await bridge.close();
  }
});

test("register resolves path from MCP roots when path is empty", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const claude = new Client(
    { name: "claude", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  claude.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: "file:///projects/from-roots", name: "root" }],
  }));
  try {
    await claude.connect(
      new StreamableHTTPClientTransport(new URL("/mcp/claude", bridge.url)),
    );
    const result = await claude.callTool({
      name: "register",
      arguments: { sessionId: "cl-1" },
    });
    assert.equal(JSON.parse(textOf(result)).path, "/projects/from-roots");
  } finally {
    await Promise.allSettled([claude.close()]);
    await bridge.close();
  }
});

test("register without path fails visibly when client has no roots", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const codex = await connect(bridge, "codex");
  try {
    const result = await codex.callTool({
      name: "register",
      arguments: { sessionId: "cx-1" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /path is required/);
  } finally {
    await Promise.allSettled([codex.close()]);
    await bridge.close();
  }
});

test("send with no matching counterpart fails visibly", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const codex = await connect(bridge, "codex");
  try {
    await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", path: "/p" } });

    const noCounterpart = await codex.callTool({
      name: "send",
      arguments: { message: "hi", selfSessionId: "cx-1", target: "claude", role: "review" },
    });
    assert.equal(noCounterpart.isError, true);
    assert.match(textOf(noCounterpart), /No claude session with role "review" at \/p/);

    const noTarget = await codex.callTool({
      name: "send",
      arguments: { message: "hi", selfSessionId: "cx-1", target: "ghost" },
    });
    assert.equal(noTarget.isError, true);
    assert.match(textOf(noTarget), /No ghost session at \/p/);
  } finally {
    await Promise.allSettled([codex.close()]);
    await bridge.close();
  }
});

test("a session that drops without DELETE keeps its registration and pair; re-register restores delivery", async () => {
  const bridge = await startBridgeHttpServer({
    host: "127.0.0.1",
    port: 0,
    disconnectGraceMs: 50,
  });
  const claude1 = await connect(bridge, "claude", "claude-1");
  const codex = await connect(bridge, "codex");
  let claude2: Client | undefined;

  try {
    await claude1.callTool({
      name: "register",
      arguments: { sessionId: "cl-1", path: "/p", role: "review" },
    });
    await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", path: "/p" } });
    const first = nextChannelMessage(claude1);
    const pending1 = codex.callTool({
      name: "send",
      arguments: { message: "one", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });
    await first;

    // Abort the connection without terminating the MCP session (no DELETE).
    await claude1.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Same logical session comes back on a new MCP connection and registers again.
    claude2 = await connect(bridge, "claude", "claude-2");
    const second = nextChannelMessage(claude2);
    await claude2.callTool({
      name: "register",
      arguments: { sessionId: "cl-1", path: "/p", role: "review" },
    });
    await claude2.callTool({
      name: "send",
      arguments: { message: "ack one", selfSessionId: "cl-1", target: "codex", role: "review" },
    });
    assert.equal(textOf(await pending1), "ack one");

    // The pair is intact: no target needed.
    const pending2 = codex.callTool({
      name: "send",
      arguments: { message: "two", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });
    assert.deepEqual(await second, { content: "two", from: "cx-1", provider: "codex", role: "review" });
    await claude2.callTool({
      name: "send",
      arguments: { message: "ack two", selfSessionId: "cl-1", target: "codex", role: "review" },
    });
    assert.equal(textOf(await pending2), "ack two");
  } finally {
    await Promise.allSettled([claude2?.close(), codex.close()]);
    await bridge.close();
  }
});

test("unregister drops the pair and fails the waiting counterpart", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushed = nextChannelMessage(claude);

  try {
    await claude.callTool({
      name: "register",
      arguments: { sessionId: "cl-1", path: "/p", role: "review" },
    });
    await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", path: "/p" } });
    const pending = codex.callTool({
      name: "send",
      arguments: { message: "one", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });
    await pushed;

    await claude.callTool({ name: "unregister", arguments: { sessionId: "cl-1" } });
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Counterpart unregistered: cl-1/);

    const again = await codex.callTool({
      name: "send",
      arguments: { message: "two", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });
    assert.equal(again.isError, true);
    assert.match(textOf(again), /No claude session with role "review" at \/p/);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("admin endpoints expose and clear the relay state", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  const claude = await connect(bridge, "claude");
  const codex = await connect(bridge, "codex");
  const pushed = nextChannelMessage(claude);
  const admin = new URL("/admin/state", bridge.url);

  try {
    await claude.callTool({ name: "register", arguments: { sessionId: "cl-1", path: "/p", role: "review" } });
    await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", path: "/p" } });
    const pending = codex.callTool({
      name: "send",
      arguments: { message: "one", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });
    await pushed;

    const state = await (await fetch(admin)).json();
    assert.equal(state.server.url, bridge.url.toString());
    assert.equal(state.server.pid, process.pid);
    assert.equal(typeof state.server.uptimeSeconds, "number");
    assert.deepEqual(state.server.mcpSessions.map((m: { provider: string }) => m.provider).sort(), ["claude", "codex"]);
    assert.deepEqual(state.registrations.map((r: { sessionId: string }) => r.sessionId).sort(), ["cl-1", "cx-1"]);
    assert.deepEqual(state.waiting, ["cx-1"]);
    assert.equal(state.pairs.length, 2);

    const cleared = await (await fetch(admin, { method: "DELETE" })).json();
    assert.deepEqual(cleared, { cleared: true, registrations: 2 });
    const result = await pending;
    assert.equal(result.isError, true);

    const { server: _server, ...after } = await (await fetch(admin)).json();
    assert.deepEqual(after, { registrations: [], pairs: [], connected: [], waiting: [] });
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("a late register on a claude transport is answered 404 once so Claude Code re-initializes", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0, claudeReinitAfterMs: 50 });
  const stale = await connect(bridge, "claude", "stale");
  let fresh: Client | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(
      stale.callTool({ name: "register", arguments: { sessionId: "cl-1", path: "/p", role: "review" } }),
      /Session reset so the client re-initializes/,
    );

    // What Claude Code does next: a new connection and the same register again.
    fresh = await connect(bridge, "claude", "fresh");
    const result = await fresh.callTool({
      name: "register",
      arguments: { sessionId: "cl-1", path: "/p", role: "review" },
    });
    assert.equal(result.isError, undefined);
    const state = await (await fetch(new URL("/admin/state", bridge.url))).json();
    assert.deepEqual(state.connected, ["cl-1"]);
    assert.equal(state.server.mcpSessions.length, 1);
  } finally {
    await Promise.allSettled([stale.close(), fresh?.close()]);
    await bridge.close();
  }
});

test("when a registered transport closes, the one fresh unregistered transport inherits the registration", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0, disconnectGraceMs: 50 });
  const throwaway = await connect(bridge, "claude", "throwaway");
  const codex = await connect(bridge, "codex");
  let replacement: Client | undefined;
  try {
    await throwaway.callTool({
      name: "register",
      arguments: { sessionId: "cl-1", path: "/p", role: "review" },
    });
    await codex.callTool({ name: "register", arguments: { sessionId: "cx-1", path: "/p" } });

    replacement = await connect(bridge, "claude", "replacement");
    const pushed = nextChannelMessage(replacement);
    await throwaway.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const state = await (await fetch(new URL("/admin/state", bridge.url))).json();
    assert.deepEqual(state.connected.sort(), ["cl-1", "cx-1"]);

    const pending = codex.callTool({
      name: "send",
      arguments: { message: "hello heir", selfSessionId: "cx-1", target: "claude", role: "review", wait: true },
    });
    assert.equal((await pushed).content, "hello heir");
    await replacement.callTool({
      name: "send",
      arguments: { message: "inherited", selfSessionId: "cl-1", target: "codex", role: "review" },
    });
    assert.equal(textOf(await pending), "inherited");
  } finally {
    await Promise.allSettled([replacement?.close(), codex.close()]);
    await bridge.close();
  }
});

test("an unknown session ID gets 404 so the client re-initializes", async () => {
  const bridge = await startBridgeHttpServer({ host: "127.0.0.1", port: 0 });
  try {
    const request = (headers: Record<string, string>) =>
      fetch(new URL("/mcp/claude", bridge.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    const unknown = await request({ "mcp-session-id": "stale-after-restart" });
    assert.equal(unknown.status, 404);

    const missing = await request({});
    assert.equal(missing.status, 400);
  } finally {
    await bridge.close();
  }
});
