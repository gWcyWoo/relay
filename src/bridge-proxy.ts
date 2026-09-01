import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface Endpoint {
  provider: string;
  sessionId: string;
}

export interface Source {
  provider: string;
}

export interface Delivery {
  bridgeId: string;
  targetSessionId: string;
  message: string;
}

export interface DeliveryReceipt {
  delivered: boolean;
}

export interface DeliveryRecord {
  eventId: string;
  bridgeId: string;
  source: Endpoint;
  target: Endpoint;
  status: "delivered" | "failed";
}

export interface SessionAdapter {
  provider: string;
  deliver(delivery: Delivery): Promise<DeliveryReceipt>;
}

interface SendInput {
  bridgeId: string;
  source: Source;
  message: string;
}

interface BridgeProxyOptions {
  storePath: string;
  adapters: SessionAdapter[];
}

function parseEndpoint(value: string): Endpoint {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid endpoint: ${value}`);
  }
  return {
    provider: value.slice(0, separator),
    sessionId: value.slice(separator + 1),
  };
}

export interface BridgeProxy {
  sendToBridge(input: SendInput): Promise<DeliveryReceipt>;
  getDeliveries(bridgeId: string): DeliveryRecord[];
}

export function createBridgeProxy(options: BridgeProxyOptions): BridgeProxy {
  const adapters = new Map(
    options.adapters.map((adapter) => [adapter.provider, adapter]),
  );
  const schemaDatabase = new DatabaseSync(options.storePath);
  schemaDatabase.exec(`
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id TEXT PRIMARY KEY,
      bridge_id TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      target_provider TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('delivered', 'failed'))
    ) STRICT;
  `);
  schemaDatabase.close();

  return {
    async sendToBridge(input: SendInput): Promise<DeliveryReceipt> {
      const database = new DatabaseSync(options.storePath, { readOnly: true });
      const row = database
        .prepare(
          "SELECT left_endpoint, right_endpoint FROM bridges WHERE bridge_id = ?",
        )
        .get(input.bridgeId) as
        | { left_endpoint: string; right_endpoint: string }
        | undefined;
      database.close();

      if (!row) {
        throw new Error(`Unknown bridge: ${input.bridgeId}`);
      }

      const left = parseEndpoint(row.left_endpoint);
      const right = parseEndpoint(row.right_endpoint);
      const sourceIsLeft =
        left.provider === input.source.provider &&
        right.provider !== input.source.provider;
      const sourceIsRight =
        right.provider === input.source.provider &&
        left.provider !== input.source.provider;
      const source = sourceIsLeft ? left : sourceIsRight ? right : undefined;
      const target = sourceIsLeft ? right : sourceIsRight ? left : undefined;
      if (!source || !target) {
        throw new Error(
          `Source provider is not uniquely part of bridge: ${input.bridgeId}`,
        );
      }

      const adapter = adapters.get(target.provider);
      if (!adapter) {
        throw new Error(`No adapter registered for provider: ${target.provider}`);
      }

      const recordDelivery = (status: DeliveryRecord["status"]): void => {
        const ledgerDatabase = new DatabaseSync(options.storePath);
        ledgerDatabase
          .prepare(`
            INSERT INTO deliveries (
              event_id,
              bridge_id,
              source_provider,
              source_session_id,
              target_provider,
              target_session_id,
              status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            randomUUID(),
            input.bridgeId,
            source.provider,
            source.sessionId,
            target.provider,
            target.sessionId,
            status,
          );
        ledgerDatabase.close();
      };

      try {
        const receipt = await adapter.deliver({
          bridgeId: input.bridgeId,
          targetSessionId: target.sessionId,
          message: input.message,
        });
        recordDelivery("delivered");
        return receipt;
      } catch (error) {
        recordDelivery("failed");
        throw error;
      }
    },

    getDeliveries(bridgeId: string): DeliveryRecord[] {
      const database = new DatabaseSync(options.storePath, { readOnly: true });
      const rows = database
        .prepare(`
          SELECT
            event_id,
            bridge_id,
            source_provider,
            source_session_id,
            target_provider,
            target_session_id,
            status
          FROM deliveries
          WHERE bridge_id = ?
          ORDER BY rowid
        `)
        .all(bridgeId) as Array<{
        event_id: string;
        bridge_id: string;
        source_provider: string;
        source_session_id: string;
        target_provider: string;
        target_session_id: string;
        status: "delivered" | "failed";
      }>;
      database.close();
      return rows.map((row) => ({
        eventId: row.event_id,
        bridgeId: row.bridge_id,
        source: {
          provider: row.source_provider,
          sessionId: row.source_session_id,
        },
        target: {
          provider: row.target_provider,
          sessionId: row.target_session_id,
        },
        status: row.status,
      }));
    },
  };
}
