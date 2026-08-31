import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridgePair } from "../src/pair-store.ts";

test("pairing retries a bridge id that already exists without replacing it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-collision-"));
  const storePath = path.join(directory, "bridge.sqlite");
  const candidates = ["12345", "12345", "67890"];
  const generateBridgeId = (): string => candidates.shift() ?? "99999";

  const firstBridgeId = createBridgePair({
    storePath,
    leftEndpoint: "claude:first",
    rightEndpoint: "codex:first",
    generateBridgeId,
  });
  const secondBridgeId = createBridgePair({
    storePath,
    leftEndpoint: "claude:second",
    rightEndpoint: "codex:second",
    generateBridgeId,
  });

  assert.equal(firstBridgeId, "12345");
  assert.equal(secondBridgeId, "67890");

  const database = new DatabaseSync(storePath, { readOnly: true });
  const rows = database
    .prepare(
      "SELECT bridge_id, left_endpoint, right_endpoint FROM bridges ORDER BY bridge_id",
    )
    .all()
    .map((row) => ({ ...row }));
  database.close();
  assert.deepEqual(rows, [
    {
      bridge_id: "12345",
      left_endpoint: "claude:first",
      right_endpoint: "codex:first",
    },
    {
      bridge_id: "67890",
      left_endpoint: "claude:second",
      right_endpoint: "codex:second",
    },
  ]);
});
