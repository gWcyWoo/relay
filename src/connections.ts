import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection } from "./relay-state.ts";

/**
 * Delivery strategy per provider. Add a provider here to teach Relay how to
 * push a message into that kind of session.
 */
type ConnectionFactory = (server: McpServer) => Connection;

/** Claude Code accepts pushes as `notifications/claude/channel`. */
const claudeChannel: ConnectionFactory = (server) => ({
  provider: "claude",
  waitsForReply: false,
  async deliver(message, from) {
    await (server.server.notification as (n: unknown) => Promise<void>)({
      method: "notifications/claude/channel",
      params: {
        content: message,
        meta: { from: from.sessionId, provider: from.provider, role: from.role },
      },
    });
  },
});

/** Providers with no push channel only receive as the return value of a waiting send. */
const waitOnly =
  (provider: string): ConnectionFactory =>
  () => ({
    provider,
    waitsForReply: true,
    async deliver() {
      throw new Error(
        `${provider} sessions cannot receive pushes; the target must be waiting in send`,
      );
    },
  });

const factories: Record<string, ConnectionFactory> = {
  claude: claudeChannel,
};

export function createConnection(provider: string, server: McpServer): Connection {
  return (factories[provider] ?? waitOnly(provider))(server);
}
