import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createConnection, macDesktop, type DesktopDriver } from "./connections.ts";
import { createRelayMcpServer } from "./mcp-server.ts";
import { createRelayState } from "./relay-state.ts";

export interface BridgeHttpServerOptions {
  host?: string;
  port?: number;
  /** How long a session may have no open channel stream before it is treated as disconnected. */
  disconnectGraceMs?: number;
  /**
   * A `register` arriving on a claude transport older than this is answered with 404 once,
   * forcing Claude Code to re-initialize. Claude Code only evaluates its channel allowlist
   * when a connection is (re)established, and the dev-channels dialog is confirmed after the
   * initial connection, so without this the session never accepts channel pushes.
   */
  claudeReinitAfterMs?: number;
  /** Window after a transport's creation in which a fresh unregistered transport may adopt its registration. */
  adoptWindowMs?: number;
  /** Host actions for desktop-driven providers; injectable for tests. */
  desktop?: DesktopDriver;
}

interface ActiveTransport {
  provider: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  channelStreams: number;
  createdAt: number;
  /** Relay sessionId registered through this transport, if any. */
  sessionId?: string;
  forcedReinit?: boolean;
  disconnectTimer?: NodeJS.Timeout;
}

function isRegisterCall(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  return method === "tools/call" && params?.name === "register";
}

export interface BridgeHttpServer {
  url: URL;
  close(): Promise<void>;
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export async function startBridgeHttpServer(
  options: BridgeHttpServerOptions = {},
): Promise<BridgeHttpServer> {
  const host = options.host ?? "127.0.0.1";
  const disconnectGraceMs = options.disconnectGraceMs ?? 3000;
  const claudeReinitAfterMs = options.claudeReinitAfterMs ?? 10_000;
  const adoptWindowMs = options.adoptWindowMs ?? 5000;
  const desktop = options.desktop ?? macDesktop;
  const app = createMcpExpressApp({ host });
  const transports = new Map<string, ActiveTransport>();
  const relay = createRelayState();
  const startedAt = new Date();
  let url: URL | undefined;

  // Operator endpoints used by `relay status` and `relay clear`.
  app.get("/admin/state", (_request, response) => {
    const sessions = [...transports.values()].map((t) => ({
      provider: t.provider,
      channelStreams: t.channelStreams,
    }));
    response.json({
      server: {
        version,
        url: url?.toString(),
        pid: process.pid,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        mcpSessions: sessions,
      },
      ...relay.snapshot(),
    });
  });
  app.delete("/admin/state", (_request, response) => {
    const before = relay.snapshot();
    relay.clear();
    response.json({ cleared: true, registrations: before.registrations.length });
  });

  app.all("/mcp/:provider", async (request, response) => {
    try {
      const provider = request.params.provider;

      const sessionHeader = request.headers["mcp-session-id"];
      const sessionId =
        typeof sessionHeader === "string" ? sessionHeader : undefined;
      let active = sessionId ? transports.get(sessionId) : undefined;

      if (active) {
        if (active.provider !== provider) {
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

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (initializedId) => {
            transports.set(initializedId, active!);
          },
        });

        const created: ActiveTransport = {
          provider,
          server: undefined as unknown as McpServer,
          transport,
          channelStreams: 0,
          createdAt: Date.now(),
        };
        server = createRelayMcpServer({
          provider,
          relay,
          desktop,
          onRegister: (id) => {
            created.sessionId = id;
          },
        });
        created.server = server;
        active = created;

        transport.onclose = () => {
          clearTimeout(created.disconnectTimer);
          if (transport.sessionId) transports.delete(transport.sessionId);
          if (created.sessionId === undefined) return;
          // Claude Code recovers an expired session by finishing the pending tool call on a
          // throwaway transport, then replacing it with a fresh one about a second later.
          // If exactly one fresh, unregistered transport of the same provider exists, it is
          // that replacement: move the registration's connection there. Otherwise the
          // registration and pairs survive, but the session must register again.
          const heirs = [...transports.values()].filter(
            (t) =>
              t !== created &&
              t.provider === created.provider &&
              t.sessionId === undefined &&
              t.createdAt >= created.createdAt &&
              t.createdAt - created.createdAt <= adoptWindowMs,
          );
          if (heirs.length === 1) {
            heirs[0].sessionId = created.sessionId;
            relay.connect(
              created.sessionId,
              createConnection(created.provider, {
                server: heirs[0].server,
                sessionId: created.sessionId,
                desktop,
              }),
            );
          } else {
            relay.disconnect(created.sessionId);
          }
        };

        await server.connect(transport);
      } else if (sessionId) {
        // Unknown session, e.g. the server restarted. MCP prescribes 404 so
        // the client discards its session ID and re-initializes.
        response.status(404).json({ error: "Unknown MCP session" });
        return;
      } else {
        response.status(400).json({ error: "Missing MCP session" });
        return;
      }

      if (
        active.provider === "claude" &&
        request.method === "POST" &&
        isRegisterCall(request.body) &&
        !active.forcedReinit &&
        Date.now() - active.createdAt > claudeReinitAfterMs
      ) {
        // See BridgeHttpServerOptions.claudeReinitAfterMs. Claude Code retries the
        // register on the new connection by itself; the retry lands on a fresh
        // transport and is accepted.
        active.forcedReinit = true;
        response.status(404).json({ error: "Session reset so the client re-initializes" });
        void active.transport.close();
        return;
      }

      if (request.method === "GET") {
        // The standalone SSE stream is the client's channel. Clients that exit
        // without sending DELETE only drop this stream, so its close is the
        // disconnect signal, after a grace period for reconnects.
        const session = active;
        session.channelStreams += 1;
        clearTimeout(session.disconnectTimer);
        response.once("close", () => {
          session.channelStreams -= 1;
          if (session.channelStreams > 0) return;
          session.disconnectTimer = setTimeout(() => {
            if (session.channelStreams === 0) void session.transport.close();
          }, disconnectGraceMs);
        });
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
  }>((resolve, reject) => {
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
  });
  const baseUrl = new URL(`http://${host}:${address.port}`);
  url = baseUrl;

  return {
    url: baseUrl,
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
