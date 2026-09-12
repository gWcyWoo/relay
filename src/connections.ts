import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
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
  /** Submit the prefilled composer in the named app with Return plus the given modifiers. */
  submit(appName: string, keys: SubmitKeys): Promise<void>;
  /** Whether the named app is installed. */
  appInstalled(appName: string): Promise<boolean>;
  /** Whether this process may send keystrokes (macOS Accessibility permission). */
  canSendKeystrokes(): Promise<boolean>;
  /**
   * Whether the Codex turn that was running at `since` in the given thread has ended.
   * Read from Codex's own thread history on this machine; throws if it cannot be read.
   */
  codexTurnEnded(threadId: string, since: Date): Promise<boolean>;
  /** How Codex desktop treats input that arrives while a turn is running (its `followUpQueueMode`). */
  codexFollowUpMode(): Promise<FollowUpMode>;
  /** Which key submits the Codex composer (its `composerEnterBehavior`). */
  codexComposerEnterBehavior(): Promise<ComposerEnterBehavior>;
  /** Whether the thread has a turn in progress right now, read from Codex's own rollout. */
  codexTurnRunning(threadId: string): Promise<boolean>;
}

export interface SubmitKeys {
  command: boolean;
  shift: boolean;
}

/** Codex desktop's follow-up behavior: queue behind the running turn, steer it, or interrupt it. */
export type FollowUpMode = "queue" | "steer" | "interrupt";
/** Codex desktop's composer: Enter submits, or Cmd+Enter does (always, or only for multi-line text). */
export type ComposerEnterBehavior = "enter" | "cmdIfMultiline" | "cmdAlways";

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

/** Codex's thread index; it maps a thread id to its rollout file. */
export function codexStatePath(): string {
  return join(codexHome(), "state_5.sqlite");
}

/** A `[desktop]` setting from config.toml, validated against its allowed values; absent means the app default. */
async function codexDesktopSetting<T extends string>(key: string, allowed: readonly T[], fallback: T): Promise<T> {
  let toml: string;
  try {
    toml = await readFile(codexConfigPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  const desktop = /^\[desktop\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  const value = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(desktop)?.[1];
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${codexConfigPath()}: ${key} is "${value}"; expected ${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}`);
  }
  return value as T;
}

/** The osascript body that submits the composer; exported so the key combination is testable. */
export function returnKeystrokeScript(appName: string, { command, shift }: SubmitKeys): string {
  const modifiers = [command && "command down", shift && "shift down"].filter(Boolean);
  const keys = modifiers.length ? `keystroke return using {${modifiers.join(", ")}}` : "keystroke return";
  return `tell application "System Events" to tell process "${appName}" to ${keys}`;
}

const TURN_START = '"type":"task_started"';
const TURN_END = ['"type":"task_complete"', '"type":"turn_aborted"'];

/** Whether the last turn event in a rollout file is a start without an end; scans from the end. */
async function lastTurnOpen(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const chunk = 64 * 1024;
    let tail = "";
    let position = size;
    while (position > 0) {
      const length = Math.min(chunk, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      tail = buffer.toString("utf8") + tail;
      const started = tail.lastIndexOf(TURN_START);
      const ended = Math.max(...TURN_END.map((m) => tail.lastIndexOf(m)));
      if (started !== -1 || ended !== -1) return started > ended;
    }
    return false;
  } finally {
    await handle.close();
  }
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
  async submit(appName, keys) {
    // The deep link focuses the composer; Return submits it. Needs Accessibility
    // permission for the app that launched Relay (System Settings > Privacy & Security).
    await run("osascript", [
      "-e", `tell application "${appName}" to activate`,
      "-e", "delay 1",
      "-e", returnKeystrokeScript(appName, keys),
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
  codexFollowUpMode() {
    // The app persists its settings under [desktop] in config.toml; a key is absent only
    // before the app ever wrote them, and then the app default applies.
    return codexDesktopSetting("followUpQueueMode", ["queue", "steer", "interrupt"], "steer");
  },
  codexComposerEnterBehavior() {
    return codexDesktopSetting("composerEnterBehavior", ["enter", "cmdIfMultiline", "cmdAlways"], "enter");
  },
  async codexTurnRunning(threadId) {
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(codexStatePath(), { readOnly: true });
    let rolloutPath: string | undefined;
    try {
      const row = db.prepare("select rollout_path from threads where id = ?").get(threadId) as
        | { rollout_path: string }
        | undefined;
      rolloutPath = row?.rollout_path;
    } finally {
      db.close();
    }
    if (rolloutPath === undefined) throw new Error(`No Codex thread ${threadId} in ${codexStatePath()}`);
    return lastTurnOpen(rolloutPath);
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
          meta: { from: from.sessionId, provider: from.provider, role: from.role },
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
    async deliver(message, from, { urgent }) {
      // While a turn runs, the app's follow-up mode decides whether new input queues or steers,
      // and one key combination does the opposite for a single message. Which combination
      // depends on how the composer submits: Enter → Cmd+Return; Cmd+Enter → Cmd+Shift+Return.
      // Idle threads take the message as a new turn, so only the plain submit key is needed.
      const [mode, enter, running] = await Promise.all([
        desktop.codexFollowUpMode(),
        desktop.codexComposerEnterBehavior(),
        desktop.codexTurnRunning(sessionId),
      ]);
      const invert = running && (urgent ? mode === "queue" : mode !== "queue");
      const keys: SubmitKeys = enter === "enter" ? { command: invert, shift: false } : { command: true, shift: invert };
      const who = from.role ? ` (role "${from.role}")` : "";
      const reply = from.role ? `send(target="${from.provider}", role="${from.role}")` : `send(target="${from.provider}")`;
      const header = `[Relay] from ${from.provider}${who}. Reply with ${reply}.`;
      const url = `codex://threads/${encodeURIComponent(sessionId)}?prompt=${encodeURIComponent(`${header}\n\n${message}`)}`;
      await desktop.open(url);
      try {
        await desktop.submit("ChatGPT", keys);
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
      name: "Codex thread state readable",
      fix: `Relay reads ${codexStatePath()} to find a thread's rollout and tell whether a turn is running. Run Codex once so the file exists, or set CODEX_HOME to its directory.`,
      check: () =>
        desktop.codexTurnRunning("relay-setup-probe").then(
          () => true,
          (error: Error) => /^No Codex thread /.test(error.message),
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
      throw new Error(`${provider} sessions cannot receive pushes; the target must be waiting in send`);
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
