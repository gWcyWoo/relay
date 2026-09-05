import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /** Whether the named app is installed. */
  appInstalled(appName: string): Promise<boolean>;
  /** Whether this process may send keystrokes (macOS Accessibility permission). */
  canSendKeystrokes(): Promise<boolean>;
  /**
   * Whether the Codex turn that was running at `since` in the given thread has ended.
   * Read from Codex's own thread history on this machine; throws if it cannot be read.
   */
  codexTurnEnded(threadId: string, since: Date): Promise<boolean>;
}

/** Codex keeps per-turn status in this database; a turn gets its row when it ends. */
export function codexHistoryPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread_history_1.sqlite");
}

let sqlite: Promise<typeof import("node:sqlite")> | undefined;

/** node:sqlite, loaded on first use without its ExperimentalWarning (which would read as a problem in `relay doctor`). */
function loadSqlite(): Promise<typeof import("node:sqlite")> {
  sqlite ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      if (String(warning).includes("SQLite is an experimental feature")) return;
      (original as (warning: string | Error, ...rest: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqlite;
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
  async appInstalled(appName) {
    try {
      await run("open", ["-Ra", appName]);
      return true;
    } catch {
      return false;
    }
  },
  async canSendKeystrokes() {
    try {
      // An empty keystroke types nothing but still needs the permission.
      await run("osascript", ["-e", 'tell application "System Events" to keystroke ""']);
      return true;
    } catch {
      return false;
    }
  },
  async codexTurnEnded(threadId, since) {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(codexHistoryPath(), { readOnly: true });
    try {
      const at = Math.floor(since.getTime() / 1000);
      const row = db
        .prepare(
          "select 1 from thread_turns where thread_id = ? and started_at <= ? and completed_at >= ? limit 1",
        )
        .get(threadId, at, at);
      return row !== undefined;
    } finally {
      db.close();
    }
  },
};

/** Something a provider needs before Relay can reach its sessions. */
export interface Requirement {
  name: string;
  /** What the user must do when the check fails or cannot be run here. */
  fix: string;
  /** true = satisfied, false = not satisfied, null = cannot be checked from the server. */
  check(): Promise<boolean | null>;
}

export interface SetupCheck {
  name: string;
  ok: boolean | null;
  fix: string;
}

interface ProviderStrategy {
  connect(context: ConnectionContext): Connection;
  requirements(desktop: DesktopDriver): Requirement[];
}

/** Claude Code accepts pushes as `notifications/claude/channel`, but only in sessions started with channels enabled. */
const claude: ProviderStrategy = {
  connect: ({ server }) => ({
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
  }),
  requirements: () => [
    {
      name: "channel pushes enabled in the Claude session",
      fix: "Start the session from the CLI with: claude --dangerously-load-development-channels server:relay and accept the dialog. Sessions created in the desktop app cannot receive pushes.",
      check: async () => null,
    },
  ],
};

/**
 * Codex desktop (ChatGPT.app). Its MCP client cannot be pushed to, but the app
 * handles `codex://threads/<id>?prompt=` by opening that thread with the prompt
 * prefilled, and the Codex sessionId is its thread id. A request from Codex still
 * blocks in send for the reply; this path is for messages sent while Codex is idle,
 * including a reply that comes after Codex ended the turn that called send.
 */
const codex: ProviderStrategy = {
  connect: ({ sessionId, desktop }) => ({
    provider: "codex",
    waitsForReply: true,
    // Codex may end its turn while the send is still open; the turn's end is recorded
    // in its thread history, so a reply after that point goes through the deep link.
    attending: async (since) => !(await desktop.codexTurnEnded(sessionId, since)),
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
  }),
  requirements: (desktop) => [
    {
      name: "ChatGPT desktop app installed",
      fix: "Install the ChatGPT desktop app; it registers the codex:// scheme Relay uses to reach Codex threads.",
      check: () => desktop.appInstalled("ChatGPT"),
    },
    {
      name: "Accessibility permission for the app that launched Relay",
      fix: "System Settings > Privacy & Security > Accessibility: enable the app you start Relay from (e.g. Terminal). Without it messages land in the Codex composer but are not submitted.",
      check: () => desktop.canSendKeystrokes(),
    },
    {
      name: "Codex thread history readable",
      fix: `Relay reads ${codexHistoryPath()} to tell whether a Codex turn is still waiting in send. Run Codex once so the file exists, or set CODEX_HOME to its directory.`,
      check: () =>
        desktop.codexTurnEnded("relay-setup-probe", new Date()).then(
          () => true,
          () => false,
        ),
    },
    {
      name: "Codex registers with its thread id as sessionId",
      fix: "In Codex, call register with sessionId set to the current thread id (the id in ~/.codex/sessions/.../rollout-*-<id>.jsonl).",
      check: async () => null,
    },
  ],
};

/** Providers with no push channel only receive as the return value of a waiting send. */
const waitOnly = (provider: string): ProviderStrategy => ({
  connect: () => ({
    provider,
    waitsForReply: true,
    async deliver() {
      throw new Error(
        `${provider} sessions cannot receive pushes; the target must be waiting in send`,
      );
    },
  }),
  requirements: () => [],
});

/** Delivery strategy per provider. Add a provider here to teach Relay how to reach its sessions. */
const strategies: Record<string, ProviderStrategy> = { claude, codex };

export function knownProviders(): string[] {
  return Object.keys(strategies);
}

export function createConnection(provider: string, context: ConnectionContext): Connection {
  return (strategies[provider] ?? waitOnly(provider)).connect(context);
}

/** Run a provider's setup checks; the result is meant to be shown to the user. */
export async function checkSetup(provider: string, desktop: DesktopDriver): Promise<SetupCheck[]> {
  const requirements = (strategies[provider] ?? waitOnly(provider)).requirements(desktop);
  return Promise.all(
    requirements.map(async ({ name, fix, check }) => ({ name, ok: await check(), fix })),
  );
}
