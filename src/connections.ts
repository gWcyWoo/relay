import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection } from "./relay-state.ts";

const run = promisify(execFile);

/** What a delivery strategy may use to reach a session. */
export interface ConnectionContext {
  server: McpServer;
  sessionId: string;
  desktop: DesktopDriver;
}

/** Host-side actions used by strategies that drive a desktop app. Injectable for tests. */
export interface DesktopDriver {
  /** Hand a URL to the app registered for its scheme (`open <url>` on macOS). */
  open(url: string): Promise<void>;
  /** Press Return in the named app so a prefilled composer submits. */
  submit(appName: string): Promise<void>;
}

export const macDesktop: DesktopDriver = {
  async open(url) {
    await run("open", [url]);
  },
  async submit(appName) {
    // The deep link focuses the composer; Return submits it. Needs Accessibility
    // permission for the app that launched Relay (System Settings > Privacy & Security).
    await run("osascript", [
      "-e", `tell application "${appName}" to activate`,
      "-e", "delay 1",
      "-e", `tell application "System Events" to tell process "${appName}" to keystroke return`,
    ]);
  },
};

/**
 * Delivery strategy per provider. Add a provider here to teach Relay how to
 * push a message into that kind of session.
 */
type ConnectionFactory = (context: ConnectionContext) => Connection;

/** Claude Code accepts pushes as `notifications/claude/channel`. */
const claudeChannel: ConnectionFactory = ({ server }) => ({
  provider: "claude",
  waitsForReply: false,
  async deliver(message, from) {
    await (server.server.notification as (n: unknown) => Promise<void>)({
      method: "notifications/claude/channel",
      params: {
        content: message,
        meta: {
          from: from.sessionId,
          provider: from.provider,
          role: from.role,
          senderRole: from.senderRole,
        },
      },
    });
  },
});

/**
 * Codex desktop (ChatGPT.app). Its MCP client cannot be pushed to, but the app
 * handles `codex://threads/<id>?prompt=` by opening that thread with the prompt
 * prefilled, and the Codex sessionId is its thread id. A request from Codex still
 * blocks in send for the reply; this path is for messages sent while Codex is idle.
 */
const codexDesktop: ConnectionFactory = ({ sessionId, desktop }) => ({
  provider: "codex",
  waitsForReply: true,
  async deliver(message, from) {
    // Replying with the pair label hits the existing pair; with the sender's registered
    // role it resolves through the registry. Either reaches the sender.
    const replyRole = from.role || from.senderRole;
    const who = from.senderRole ? ` (role "${from.senderRole}")` : "";
    const header = `[Relay] from ${from.provider}${who}. Reply with send(target="${from.provider}", role="${replyRole}").`;
    const url = `codex://threads/${encodeURIComponent(sessionId)}?prompt=${encodeURIComponent(`${header}\n\n${message}`)}`;
    await desktop.open(url);
    try {
      await desktop.submit("ChatGPT");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Message is in the Codex composer for thread ${sessionId} but was not submitted: ${reason}. ` +
          "Press Return in Codex, or grant Accessibility permission to the app that launched Relay.",
      );
    }
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
  codex: codexDesktop,
};

export function createConnection(provider: string, context: ConnectionContext): Connection {
  return (factories[provider] ?? waitOnly(provider))(context);
}
