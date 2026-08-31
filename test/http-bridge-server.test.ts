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
        bridge.endpoint("claude", "claude-session-1"),
      ),
    );
    await codex.connect(
      new StreamableHTTPClientTransport(
        bridge.endpoint("codex", "codex-thread-1"),
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
