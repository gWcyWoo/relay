import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  BridgeProxy,
  Delivery,
  DeliveryReceipt,
  Endpoint,
  SessionAdapter,
} from "./bridge-proxy.ts";
import { createBridgeMcpServer } from "./mcp-server.ts";

interface ClaudeChannelEndpointOptions {
  source: Endpoint;
}

export function createClaudeChannelEndpoint(
  options: ClaudeChannelEndpointOptions,
): {
  adapter: SessionAdapter;
  createServer(proxy: BridgeProxy): McpServer;
} {
  let server: McpServer | undefined;

  const adapter: SessionAdapter = {
    provider: "claude",
    async deliver(delivery: Delivery): Promise<DeliveryReceipt> {
      if (!server) {
        throw new Error("Claude channel is not connected");
      }
      await server.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: delivery.message,
          meta: { bridgeId: delivery.bridgeId },
        },
      } as never);
      return { delivered: true };
    },
  };

  return {
    adapter,
    createServer(proxy) {
      if (server) {
        throw new Error("Claude channel server already created");
      }
      server = createBridgeMcpServer({
        proxy,
        source: options.source,
        channel: true,
      });
      return server;
    },
  };
}
