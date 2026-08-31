import { randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

interface CreateBridgePairOptions {
  storePath: string;
  leftEndpoint: string;
  rightEndpoint: string;
  generateBridgeId?: () => string;
}

function generateFiveDigitBridgeId(): string {
  return randomInt(100_000).toString().padStart(5, "0");
}

export function createBridgePair(options: CreateBridgePairOptions): string {
  const database = new DatabaseSync(options.storePath);
  const generateBridgeId = options.generateBridgeId ?? generateFiveDigitBridgeId;

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS bridges (
        bridge_id TEXT PRIMARY KEY,
        left_endpoint TEXT NOT NULL,
        right_endpoint TEXT NOT NULL
      ) STRICT;
    `);
    const insert = database.prepare(`
      INSERT OR IGNORE INTO bridges (bridge_id, left_endpoint, right_endpoint)
      VALUES (?, ?, ?)
    `);

    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      const bridgeId = generateBridgeId();
      const result = insert.run(
        bridgeId,
        options.leftEndpoint,
        options.rightEndpoint,
      );
      if (result.changes === 1) {
        return bridgeId;
      }
    }
  } finally {
    database.close();
  }

  throw new Error("No five-digit bridge IDs available");
}
