import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { CodexAppServerClient } from "../src/codex-adapter.ts";
import { startBridgeHttpServer } from "../src/http-bridge-server.ts";

const execFileAsync = promisify(execFile);
const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

test("Claude and Codex exchange messages through one HTTP MCP proxy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-http-"));
  const storePath = path.join(directory, "bridge.sqlite");
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    path.resolve("src/cli.ts"),
    "pair",
    "--store",
    storePath,
    "claude:claude-session-1",
    "codex:codex-thread-1",
  ]);
  const { bridgeId } = JSON.parse(stdout) as { bridgeId: string };
  const codexCalls: Array<{ method: string; threadId: string; message?: string }> = [];
  const codexAppServer: CodexAppServerClient = {
    async resumeThread(threadId) {
      codexCalls.push({ method: "thread/resume", threadId });
    },
    async startTurn(threadId, message) {
      codexCalls.push({ method: "turn/start", threadId, message });
    },
  };
  const bridge = await startBridgeHttpServer({
    storePath,
    codexAppServer,
    host: "127.0.0.1",
    port: 0,
  });
  const claude = new Client({ name: "claude", version: "1.0.0" });
  const codex = new Client({ name: "codex", version: "1.0.0" });
  const channelMessages: Array<z.infer<typeof ChannelNotificationSchema>> = [];
  let receiveChannelMessage: () => void = () => {};
  const channelMessageReceived = new Promise<void>((resolve) => {
    receiveChannelMessage = resolve;
  });
  claude.setNotificationHandler(ChannelNotificationSchema, (notification) => {
    channelMessages.push(notification);
    receiveChannelMessage();
  });

  try {
    await claude.connect(
      new StreamableHTTPClientTransport(
        new URL("/mcp/claude", bridge.url),
      ),
    );
    await codex.connect(
      new StreamableHTTPClientTransport(
        new URL("/mcp/codex", bridge.url),
      ),
    );

    await claude.callTool({
      name: "send",
      arguments: { bridgeId, message: "Implement the approved design." },
    });
    assert.deepEqual(codexCalls, [
      { method: "thread/resume", threadId: "codex-thread-1" },
      {
        method: "turn/start",
        threadId: "codex-thread-1",
        message: "Implement the approved design.",
      },
    ]);

    await codex.callTool({
      name: "send",
      arguments: { bridgeId, message: "Which target should I deploy to?" },
    });
    await channelMessageReceived;
    assert.deepEqual(channelMessages, [
      {
        method: "notifications/claude/channel",
        params: {
          content: "Which target should I deploy to?",
          meta: { bridgeId },
        },
      },
    ]);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    await bridge.close();
  }
});

test("one provider MCP configuration routes multiple bridges independently", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-multiple-http-"));
  const storePath = path.join(directory, "bridge.sqlite");
  const pair = async (claudeSessionId: string, codexThreadId: string) => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      path.resolve("src/cli.ts"),
      "pair",
      "--store",
      storePath,
      `claude:${claudeSessionId}`,
      `codex:${codexThreadId}`,
    ]);
    return (JSON.parse(stdout) as { bridgeId: string }).bridgeId;
  };
  const firstBridgeId = await pair("claude-session-1", "codex-thread-1");
  const secondBridgeId = await pair("claude-session-2", "codex-thread-2");
  const codexCalls: Array<{ method: string; threadId: string; message?: string }> = [];
  const bridge = await startBridgeHttpServer({
    storePath,
    codexAppServer: {
      async resumeThread(threadId) {
        codexCalls.push({ method: "thread/resume", threadId });
      },
      async startTurn(threadId, message) {
        codexCalls.push({ method: "turn/start", threadId, message });
      },
    },
    host: "127.0.0.1",
    port: 0,
  });
  const firstClaude = new Client({ name: "claude-one", version: "1.0.0" });
  const secondClaude = new Client({ name: "claude-two", version: "1.0.0" });
  const codex = new Client({ name: "codex", version: "1.0.0" });
  const firstMessages: Array<z.infer<typeof ChannelNotificationSchema>> = [];
  const secondMessages: Array<z.infer<typeof ChannelNotificationSchema>> = [];
  let receiveFirstMessage: () => void = () => {};
  let receiveSecondMessage: () => void = () => {};
  const firstMessageReceived = new Promise<void>((resolve) => {
    receiveFirstMessage = resolve;
  });
  const secondMessageReceived = new Promise<void>((resolve) => {
    receiveSecondMessage = resolve;
  });
  firstClaude.setNotificationHandler(ChannelNotificationSchema, (notification) => {
    firstMessages.push(notification);
    receiveFirstMessage();
  });
  secondClaude.setNotificationHandler(ChannelNotificationSchema, (notification) => {
    secondMessages.push(notification);
    receiveSecondMessage();
  });

  try {
    await firstClaude.connect(
      new StreamableHTTPClientTransport(bridge.endpoint("claude")),
    );
    await secondClaude.connect(
      new StreamableHTTPClientTransport(bridge.endpoint("claude")),
    );
    await codex.connect(
      new StreamableHTTPClientTransport(bridge.endpoint("codex")),
    );

    await firstClaude.callTool({
      name: "send",
      arguments: { bridgeId: firstBridgeId, message: "First task." },
    });
    await secondClaude.callTool({
      name: "send",
      arguments: { bridgeId: secondBridgeId, message: "Second task." },
    });
    assert.deepEqual(codexCalls, [
      { method: "thread/resume", threadId: "codex-thread-1" },
      { method: "turn/start", threadId: "codex-thread-1", message: "First task." },
      { method: "thread/resume", threadId: "codex-thread-2" },
      { method: "turn/start", threadId: "codex-thread-2", message: "Second task." },
    ]);

    await codex.callTool({
      name: "send",
      arguments: { bridgeId: secondBridgeId, message: "Second question." },
    });
    await codex.callTool({
      name: "send",
      arguments: { bridgeId: firstBridgeId, message: "First question." },
    });
    await Promise.all([firstMessageReceived, secondMessageReceived]);
    assert.deepEqual(
      firstMessages.map((notification) => notification.params),
      [{ content: "First question.", meta: { bridgeId: firstBridgeId } }],
    );
    assert.deepEqual(
      secondMessages.map((notification) => notification.params),
      [{ content: "Second question.", meta: { bridgeId: secondBridgeId } }],
    );
  } finally {
    await Promise.allSettled([
      firstClaude.close(),
      secondClaude.close(),
      codex.close(),
    ]);
    await bridge.close();
  }
});

test("Codex send fails visibly before the bridge has a Claude Channel", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-disconnected-http-"));
  const storePath = path.join(directory, "bridge.sqlite");
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    path.resolve("src/cli.ts"),
    "pair",
    "--store",
    storePath,
    "claude:claude-session-1",
    "codex:codex-thread-1",
  ]);
  const { bridgeId } = JSON.parse(stdout) as { bridgeId: string };
  const bridge = await startBridgeHttpServer({
    storePath,
    codexAppServer: {
      async resumeThread() {},
      async startTurn() {},
    },
    host: "127.0.0.1",
    port: 0,
  });
  const codex = new Client({ name: "codex", version: "1.0.0" });

  try {
    await codex.connect(
      new StreamableHTTPClientTransport(bridge.endpoint("codex")),
    );
    const result = await codex.callTool({
      name: "send",
      arguments: { bridgeId, message: "Are you there?" },
    });

    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      new RegExp(`Claude channel is not connected for bridge: ${bridgeId}`),
    );
  } finally {
    await codex.close().catch(() => {});
    await bridge.close();
  }
});

test("session-specific MCP endpoints are not exposed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-old-endpoint-http-"));
  const storePath = path.join(directory, "bridge.sqlite");
  await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    path.resolve("src/cli.ts"),
    "pair",
    "--store",
    storePath,
    "claude:claude-session-1",
    "codex:codex-thread-1",
  ]);
  const bridge = await startBridgeHttpServer({
    storePath,
    codexAppServer: {
      async resumeThread() {},
      async startTurn() {},
    },
    host: "127.0.0.1",
    port: 0,
  });
  const client = new Client({ name: "legacy-client", version: "1.0.0" });

  try {
    await assert.rejects(
      client.connect(
        new StreamableHTTPClientTransport(
          new URL("/mcp/claude/claude-session-1", bridge.url),
        ),
      ),
      /Cannot POST \/mcp\/claude\/claude-session-1/,
    );
  } finally {
    await client.close().catch(() => {});
    await bridge.close();
  }
});
