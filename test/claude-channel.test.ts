import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createBridgeProxy } from "../src/bridge-proxy.ts";
import { createClaudeChannelEndpoint } from "../src/claude-channel.ts";

const execFileAsync = promisify(execFile);
const ChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

test("a Codex message is pushed into the paired Claude session as a channel event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-channel-"));
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
  const endpoint = createClaudeChannelEndpoint({
    source: { provider: "claude", sessionId: "claude-session-1" },
  });
  const proxy = createBridgeProxy({ storePath, adapters: [endpoint.adapter] });
  const server = endpoint.createServer(proxy);
  const client = new Client({ name: "claude-client", version: "1.0.0" });
  const notifications: Array<z.infer<typeof ChannelNotificationSchema>> = [];
  client.setNotificationHandler(ChannelNotificationSchema, (notification) => {
    notifications.push(notification);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  await proxy.sendToBridge({
    bridgeId,
    source: { provider: "codex" },
    message: "Which deployment target should I use?",
  });

  assert.deepEqual(notifications, [
    {
      method: "notifications/claude/channel",
      params: {
        content: "Which deployment target should I use?",
        meta: { bridgeId },
      },
    },
  ]);

  await client.close();
  await server.close();
});
