import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkSetup, createConnection, macDesktop, type DesktopDriver } from "./connections.ts";
import type { Peering } from "./peering.ts";
import type { RelayState } from "./relay-state.ts";

interface RelayMcpServerOptions {
  /** Provider name taken from the endpoint path, e.g. "claude" or "codex". */
  provider: string;
  relay: RelayState;
  /** Binds sessions across relays and tells peers when a session leaves. */
  peering: Pick<Peering, "bind" | "unregister">;
  /** Called with the sessionId once this MCP session registers, so the bridge can drop its connection on close. */
  onRegister?: (sessionId: string) => void;
  /** Host actions for desktop-driven providers; defaults to the real macOS driver. */
  desktop?: DesktopDriver;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

/**
 * Codex runs MCP calls inside an exec cell that yields after `yield_time_ms` and then polls with
 * wait/sleep; every poll is a full-context model call. A 1 s yield turned one send into 10-20 calls
 * (see the executor rollouts of 2026-09-11..15), so tell it to yield for as long as the relay waits.
 */
const CODEX_WAITING_GUIDANCE =
  "Cost rule for send: the call blocks until the counterpart answers (up to 4 minutes), and every wake-up to check on it is a full model call. " +
  "So run send with the longest yield your exec tool allows, e.g. `// @exec: {\"yield_time_ms\": 240000}`, and if the cell is still running when it yields, call wait on it with the same long yield_time_ms. " +
  "Never poll it with short waits or sleep loops.";

export function createRelayMcpServer(options: RelayMcpServerOptions): McpServer {
  const { provider, relay, peering } = options;
  const desktop = options.desktop ?? macDesktop;
  const server = new McpServer(
    { name: "relay", version: "0.4.0" },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions:
        (provider === "codex" ? CODEX_WAITING_GUIDANCE + " " : "") +
        "You are connected to Relay. Call register(sessionId, role) once; the result carries this session's token, which the user hands to a counterpart session. To bind to a counterpart, call register again with that session's token: each token adds one binding, your own token never changes, the counterpart may be on another machine, and it is told who bound to it (the result says whether that notice was delivered). Roles are unique among the sessions bound to one counterpart, so a binding whose role that counterpart already has is refused: pick another role and register again. The result's bound list is the only place your bindings are shown, so read it. Then send(message, selfSessionId, role, urgent) reaches a bound session by its role (e.g. 'review'); target (its provider, or a bound sessionId such as meta.from of a received push) is only needed when the role is unknown. Set urgent only when the message must interrupt the counterpart's current work (a Codex turn is steered instead of the message waiting behind it). A message pushed to you via the channel carries meta.from (sender sessionId), meta.provider and meta.role; answer with send using role=meta.role. Nothing relayed may stay hidden from the user: the pushed message is not rendered by the client, so start your response by showing who sent it and its full text; and after you reply with send, show the full text you sent, not a summary. Sessions without a push channel (e.g. codex) block in send until the reply arrives, so keep waiting on that call; after 4 minutes without a reply the call returns a note and the reply, when it comes, arrives as a new turn in your session, as does an answer that comes while you are not waiting or after you ended the turn that called send. Sending again while a reply is pending is fine: the newer send takes over the wait. Sessions with a push channel (claude) return immediately. Claude Code sessions see one reconnect right after register: Relay forces it so the session starts accepting channel pushes, and the registration survives it, so do not register again or reconnect manually. Call unregister to leave; bindings on both sides are dropped.",
    },
  );

  server.registerTool(
    "register",
    {
      description:
        "Register this session and get its token, or bind it to a counterpart by passing that session's token. If the result contains setupProblems, tell the user each one with its fix; otherwise nothing needs attention.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Stable id of this session, kept across reconnects."),
        role: z.string().min(1).describe("Role label such as review or executor; counterparts address you by it, so it must differ from the roles they already have bound."),
        token: z
          .string()
          .optional()
          .describe("A counterpart session's token (secret@host:port) to bind to. Omit to only register."),
      },
    },
    async ({ sessionId, role, token }) => {
      const registration = relay.register({ sessionId, provider, role });
      relay.connect(sessionId, createConnection(provider, { server, sessionId, desktop }));
      options.onRegister?.(sessionId);
      const notice = token === undefined ? undefined : await peering.bind(registration, token);
      // Only real failures are reported; passing and uncheckable items stay silent
      // (see `relay doctor` for the full list).
      const setupProblems = (await checkSetup(provider, desktop)).filter((c) => c.ok === false);
      return text({
        registered: true,
        sessionId,
        provider,
        role,
        token: registration.token,
        bound: relay.bindingsOf(sessionId).map(({ sessionId, provider, role, address }) => ({
          sessionId,
          provider,
          role,
          ...(address === undefined ? {} : { address }),
        })),
        ...(notice === undefined ? {} : notice.notified ? { notified: true } : { notified: false, notifyError: notice.error }),
        ...(setupProblems.length > 0 ? { setupProblems } : {}),
      });
    },
  );

  server.registerTool(
    "send",
    {
      description:
        "Send a message to a bound session. Name the counterpart by role (unique among your bindings); target (its provider or a bound sessionId) is only needed when role is unknown. Codex blocks here until the counterpart answers and gets its message back, so keep waiting on this call; after 4 minutes without an answer it returns a note and the answer arrives later as a new turn in the Codex thread, as it does when the answer comes while Codex is not waiting. Claude returns at once.",
      inputSchema: {
        message: z.string().min(1),
        selfSessionId: z.string().min(1),
        target: z
          .string()
          .default("")
          .describe("Optional when role is given. Counterpart provider, e.g. 'claude', or a bound sessionId from meta.from."),
        role: z.string().default("").describe("Counterpart role, e.g. review or executor; unique among your bindings, so it alone names the counterpart."),
        urgent: z
          .boolean()
          .default(false)
          .describe("Set true whenever the user marks the message as urgent, priority or 插队: it interrupts the counterpart's current work (Codex: steers the running turn) instead of queueing behind it."),
      },
    },
    async ({ message, selfSessionId, target, role, urgent }) => {
      const reply = await relay.send({ message, selfSessionId, target, role, urgent });
      return text(reply === "" ? { sent: true } : reply);
    },
  );

  server.registerTool(
    "unregister",
    {
      description: "Leave Relay. Bindings involving this session are dropped on both sides and waiting counterparts get an error.",
      inputSchema: { sessionId: z.string().min(1) },
    },
    async ({ sessionId }) => {
      await peering.unregister(sessionId);
      return text({ unregistered: true, sessionId });
    },
  );

  return server;
}
