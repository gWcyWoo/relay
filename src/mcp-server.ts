import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createConnection, macDesktop, type DesktopDriver } from "./connections.ts";
import type { RelayState } from "./relay-state.ts";

interface RelayMcpServerOptions {
  /** Provider name taken from the endpoint path, e.g. "claude" or "codex". */
  provider: string;
  relay: RelayState;
  /** Called with the sessionId once this MCP session registers, so the bridge can drop its connection on close. */
  onRegister?: (sessionId: string) => void;
  /** Host actions for desktop-driven providers; defaults to the real macOS driver. */
  desktop?: DesktopDriver;
}

const pathSchema = z
  .string()
  .default("")
  .describe(
    "Project directory path. Leave empty to resolve from the client's MCP roots; pass explicitly if the client does not expose roots.",
  );

async function resolvePath(server: McpServer, path: string): Promise<string> {
  if (path !== "") return path;
  if (!server.server.getClientCapabilities()?.roots) {
    throw new Error("path is required: this client does not support MCP roots");
  }
  const { roots } = await server.server.listRoots();
  if (roots.length === 0) {
    throw new Error("path is required: client returned no MCP roots");
  }
  return fileURLToPath(roots[0].uri);
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

export function createRelayMcpServer(options: RelayMcpServerOptions): McpServer {
  const { provider, relay } = options;
  const desktop = options.desktop ?? macDesktop;
  const server = new McpServer(
    { name: "relay", version: "0.3.0" },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions:
        "You are connected to Relay. Call register with your sessionId, path and role. Call send(message, selfSessionId, target, role) to message another session: target is the counterpart's provider (e.g. 'claude') and role its role (e.g. 'review'); Relay finds that session in your project and pairs you, so every send looks the same. A message pushed to you via the channel carries meta.from (sender sessionId), meta.provider and meta.role; answer with send using target=meta.provider and that role, or target=meta.from when several requesters share the role. Sessions without a push channel (e.g. codex) block in send until the reply arrives; sessions with one (claude) return immediately. Call unregister to leave.",
    },
  );

  server.registerTool(
    "register",
    {
      description: "Register this session so other sessions can pair with it.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Stable id of this session, kept across reconnects."),
        path: pathSchema,
        role: z.string().default("").describe("Role label such as review or test; used to match pairs."),
      },
    },
    async ({ sessionId, path, role }) => {
      const resolvedPath = await resolvePath(server, path);
      relay.register({ sessionId, provider, path: resolvedPath, role });
      relay.connect(sessionId, createConnection(provider, { server, sessionId, desktop }));
      options.onRegister?.(sessionId);
      return text({ registered: true, sessionId, provider, path: resolvedPath, role });
    },
  );

  server.registerTool(
    "send",
    {
      description:
        "Send a message to a paired session. Pass target (counterpart provider) and role; Relay resolves the session in your project. Providers without a push channel (e.g. codex) block here until the counterpart answers and get its message back; others return at once.",
      inputSchema: {
        message: z.string().min(1),
        selfSessionId: z.string().min(1),
        target: z
          .string()
          .min(1)
          .describe("Counterpart provider, e.g. 'claude'. A sessionId from meta.from is also accepted."),
        role: z.string().default("").describe("Counterpart role, e.g. review or test."),
      },
    },
    async ({ message, selfSessionId, target, role }) => {
      const reply = await relay.send({ message, selfSessionId, target, role });
      return text(reply === "" ? { sent: true } : reply);
    },
  );

  server.registerTool(
    "unregister",
    {
      description: "Leave Relay. Pairs involving this session are dropped and waiting counterparts get an error.",
      inputSchema: { sessionId: z.string().min(1) },
    },
    async ({ sessionId }) => {
      relay.unregister(sessionId);
      return text({ unregistered: true, sessionId });
    },
  );

  return server;
}
