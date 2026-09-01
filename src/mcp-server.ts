import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BridgeProxy, Source } from "./bridge-proxy.ts";

interface BridgeMcpServerOptions {
  proxy: BridgeProxy;
  source: Source;
  channel?: boolean;
  onSend?: (bridgeId: string) => void;
}

export function createBridgeMcpServer(options: BridgeMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "relay", version: "0.1.0" },
    options.channel
      ? {
          capabilities: { experimental: { "claude/channel": {} } },
          instructions:
            "Messages from the paired session arrive as channel events. Reply through send using the same bridgeId.",
        }
      : undefined,
  );

  server.registerTool(
    "send",
    {
      description: "Send a message to the session paired by bridgeId.",
      inputSchema: {
        bridgeId: z.string().min(1),
        message: z.string().min(1),
      },
    },
    async ({ bridgeId, message }) => {
      options.onSend?.(bridgeId);
      const receipt = await options.proxy.sendToBridge({
        bridgeId,
        source: options.source,
        message,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(receipt),
          },
        ],
      };
    },
  );

  return server;
}
