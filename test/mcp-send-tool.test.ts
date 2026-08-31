import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createBridgeProxy,
  type Delivery,
  type SessionAdapter,
} from "../src/bridge-proxy.ts";
import { createBridgeMcpServer } from "../src/mcp-server.ts";

const execFileAsync = promisify(execFile);

test("an endpoint sends through the single send MCP tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-mcp-"));
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
  const deliveries: Delivery[] = [];
  const codexAdapter: SessionAdapter = {
    provider: "codex",
    async deliver(delivery) {
      deliveries.push(delivery);
      return { delivered: true };
    },
  };
  const proxy = createBridgeProxy({ storePath, adapters: [codexAdapter] });
  const server = createBridgeMcpServer({
    proxy,
    source: { provider: "claude", sessionId: "claude-session-1" },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  assert.equal(client.getServerVersion()?.name, "relay");

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["send"],
  );

  const result = await client.callTool({
    name: "send",
    arguments: { bridgeId, message: "Implement the design." },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(deliveries, [
    {
      bridgeId,
      targetSessionId: "codex-thread-1",
      message: "Implement the design.",
    },
  ]);

  await client.close();
  await server.close();
});
