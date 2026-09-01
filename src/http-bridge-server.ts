import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createBridgeProxy,
  type Delivery,
  type DeliveryReceipt,
  type SessionAdapter,
  type Source,
} from "./bridge-proxy.ts";
import type { CodexAppServerClient } from "./codex-adapter.ts";
import { createCodexAdapter } from "./codex-adapter.ts";
import { createBridgeMcpServer } from "./mcp-server.ts";

interface BridgeHttpServerOptions {
  storePath: string;
  codexAppServer: CodexAppServerClient;
  host?: string;
  port?: number;
}

interface ActiveTransport {
  source: Source;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  bridgeIds: Set<string>;
}

export interface BridgeHttpServer {
  url: URL;
  endpoint(provider: "claude" | "codex"): URL;
  close(): Promise<void>;
}

function parseSource(provider: string): Source {
  if (provider !== "claude" && provider !== "codex") {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return { provider };
}

export async function startBridgeHttpServer(
  options: BridgeHttpServerOptions,
): Promise<BridgeHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });
  const transports = new Map<string, ActiveTransport>();
  const claudeConnections = new Map<string, McpServer>();

  const claudeAdapter: SessionAdapter = {
    provider: "claude",
    async deliver(delivery: Delivery): Promise<DeliveryReceipt> {
      const server = claudeConnections.get(delivery.bridgeId);
      if (!server) {
        throw new Error(
          `Claude channel is not connected for bridge: ${delivery.bridgeId}`,
        );
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
  const proxy = createBridgeProxy({
    storePath: options.storePath,
    adapters: [claudeAdapter, createCodexAdapter(options.codexAppServer)],
  });

  app.all("/mcp/:provider", async (request, response) => {
    try {
      const source = parseSource(request.params.provider);
      const sessionHeader = request.headers["mcp-session-id"];
      const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
      let active = sessionId ? transports.get(sessionId) : undefined;

      if (active) {
        if (
          active.source.provider !== source.provider
        ) {
          response.status(403).json({ error: "MCP session endpoint mismatch" });
          return;
        }
      } else if (
        request.method === "POST" &&
        !sessionId &&
        isInitializeRequest(request.body)
      ) {
        let transport: StreamableHTTPServerTransport;
        let server: McpServer;
        const bridgeIds = new Set<string>();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (initializedId) => {
            transports.set(initializedId, {
              source,
              server,
              transport,
              bridgeIds,
            });
          },
        });
        server = createBridgeMcpServer({
          proxy,
          source,
          channel: source.provider === "claude",
          onSend(bridgeId) {
            if (source.provider !== "claude") return;
            bridgeIds.add(bridgeId);
            claudeConnections.set(bridgeId, server);
          },
        });
        active = { source, server, transport, bridgeIds };
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
          for (const bridgeId of bridgeIds) {
            if (claudeConnections.get(bridgeId) === server) {
              claudeConnections.delete(bridgeId);
            }
          }
        };
        await server.connect(transport);
      } else {
        response.status(400).json({ error: "Invalid or missing MCP session" });
        return;
      }

      await active.transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  const { httpServer, address } = await new Promise<{
    httpServer: ReturnType<typeof app.listen>;
    address: AddressInfo;
  }>(
    (resolve, reject) => {
      const listening = app.listen(options.port ?? 0, host, (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        const boundAddress = listening.address();
        if (!boundAddress || typeof boundAddress === "string") {
          reject(new Error("Bridge HTTP server did not bind a TCP address"));
          return;
        }
        resolve({ httpServer: listening, address: boundAddress });
      });
      listening.once("error", reject);
    },
  );
  const baseUrl = new URL(`http://${host}:${address.port}`);

  return {
    url: baseUrl,
    endpoint(provider) {
      return new URL(`/mcp/${encodeURIComponent(provider)}`, baseUrl);
    },
    async close() {
      await Promise.allSettled(
        [...transports.values()].map(({ server }) => server.close()),
      );
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
