import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  createBridgeProxy,
  type Delivery,
  type SessionAdapter,
} from "../src/bridge-proxy.ts";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("src/cli.ts");

test("a Claude endpoint sends a message to its paired Codex session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-send-"));
  const storePath = path.join(directory, "bridge.sqlite");
  const { stdout } = await execFileAsync(process.execPath, [
    "--experimental-strip-types",
    cliPath,
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

  const receipt = await proxy.sendToBridge({
    bridgeId,
    source: { provider: "claude", sessionId: "claude-session-1" },
    message: "Implement the approved design.",
  });

  assert.deepEqual(receipt, { delivered: true });
  assert.deepEqual(deliveries, [
    {
      bridgeId,
      targetSessionId: "codex-thread-1",
      message: "Implement the approved design.",
    },
  ]);
});
