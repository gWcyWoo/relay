import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createBridgeProxy, type SessionAdapter } from "../src/bridge-proxy.ts";

const execFileAsync = promisify(execFile);

test("a successful delivery remains visible after the proxy is reopened", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-ledger-"));
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
  const codexAdapter: SessionAdapter = {
    provider: "codex",
    async deliver() {
      return { delivered: true };
    },
  };
  const sender = createBridgeProxy({ storePath, adapters: [codexAdapter] });

  await sender.sendToBridge({
    bridgeId,
    source: { provider: "claude", sessionId: "claude-session-1" },
    message: "Implement the approved design.",
  });

  const reopened = createBridgeProxy({ storePath, adapters: [] });
  const deliveries = reopened.getDeliveries(bridgeId);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].eventId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    {
      bridgeId: deliveries[0].bridgeId,
      source: deliveries[0].source,
      target: deliveries[0].target,
      status: deliveries[0].status,
    },
    {
      bridgeId,
      source: { provider: "claude", sessionId: "claude-session-1" },
      target: { provider: "codex", sessionId: "codex-thread-1" },
      status: "delivered",
    },
  );
});

test("a failed delivery is reported and remains visible", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-failed-"));
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
  const codexAdapter: SessionAdapter = {
    provider: "codex",
    async deliver() {
      throw new Error("Codex session is offline");
    },
  };
  const proxy = createBridgeProxy({ storePath, adapters: [codexAdapter] });

  await assert.rejects(
    proxy.sendToBridge({
      bridgeId,
      source: { provider: "claude", sessionId: "claude-session-1" },
      message: "Implement the approved design.",
    }),
    /Codex session is offline/,
  );

  const deliveries = proxy.getDeliveries(bridgeId);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, "failed");
});
