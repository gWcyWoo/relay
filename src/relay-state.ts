/**
 * Relay core. Three tables:
 *  - registrations: sessionId -> who the session is (provider, role) and its token.
 *    The token (`secret@host:port`) is the session's address; another session binds to it
 *    by registering with that token. Registering again keeps the token.
 *  - bindings: sessionId -> counterpart sessions it may talk to. Written on both sides when
 *    the counterpart is registered here; one-sided, with the peer relay's address, when it
 *    lives on another relay. send resolves its target among the sender's bindings only.
 *  - connections: sessionId -> delivery strategy (see connections.ts); a remote counterpart's
 *    connection forwards to its relay.
 * Plus `waiting`: sessions blocked inside send because their strategy waits for the reply
 * (providers without a push channel); resolved by the counterpart's next send, unless the
 * strategy reports the session stopped reading, in which case that send is pushed instead.
 */

export interface Registration {
  sessionId: string;
  provider: string;
  role: string;
  /** This session's own token, minted on first register. */
  token: string;
}

export interface Binding {
  sessionId: string;
  provider: string;
  role: string;
  /** The counterpart's token; it authorizes messages and unbind notices sent to it. */
  token: string;
  /** Base URL of the relay holding the counterpart; absent when it is registered here. */
  address?: string;
}

export interface Sender {
  sessionId: string;
  provider: string;
  /** The sender's registered role, so the receiver can address it. */
  role: string;
}

/** How a pushed message should land in a session that is busy. */
export interface Delivery {
  /** Interrupt the session's current work with this message instead of queueing behind it. */
  urgent: boolean;
}

export interface Connection {
  provider: string;
  /** Push a message to this session. Throws if the provider cannot receive pushes. */
  deliver(message: string, from: Sender, delivery: Delivery): Promise<void>;
  /** Whether this provider's send blocks until the counterpart answers (true when it cannot be pushed to). */
  waitsForReply: boolean;
  /**
   * Whether the session is still reading a send it started at `since`. Absent means always.
   * Providers whose sessions can end their turn while a send is still open (codex) report
   * false once that turn ended; the reply is then pushed via `deliver` instead.
   */
  attending?(since: Date): Promise<boolean>;
}

/** Returned to a blocked send whose session stopped reading before the reply came. */
export const STALE_WAIT_NOTE =
  "[Relay] The reply arrived after you stopped reading this send; it was delivered to your session as a new turn instead.";

/** Returned to a blocked send when the same session sends again before the reply came. */
export const SUPERSEDED_WAIT_NOTE =
  "[Relay] You sent again before a reply came; the reply will return from that newer send, or arrive as a new turn.";

/** Blocking sends give up after this long; the Codex MCP client abandons a tool call at 300 s. */
export const DEFAULT_WAIT_LIMIT_MS = 240_000;

/** Returned to a blocked send that reached the wait limit; the reply then arrives as a new turn. */
export function waitLimitNote(waitLimitMs: number): string {
  return `[Relay] No reply within ${Math.round(waitLimitMs / 1000)} seconds; when it comes it will be delivered to your session as a new turn.`;
}

export interface SendOptions {
  message: string;
  selfSessionId: string;
  /** Counterpart provider, e.g. "claude", matched among the sender's bindings; a bound sessionId is also accepted. Empty: any provider. */
  target?: string;
  /** Counterpart role, e.g. "review"; roles are unique among a session's bindings, so this alone names a counterpart. Empty matches any role. */
  role?: string;
  /** Interrupt the counterpart's current work with this message instead of queueing behind it. */
  urgent?: boolean;
  /** For providers whose send blocks for the reply: false returns once delivered; a reply then arrives as a push. Default true. */
  wait?: boolean;
}

export interface RelaySnapshot {
  registrations: Registration[];
  bindings: Array<{
    sessionId: string;
    counterparts: Array<{ sessionId: string; provider: string; role: string; address?: string }>;
  }>;
  /** Sessions with a live delivery connection. */
  connected: string[];
  /** Sessions currently blocked inside send waiting for a reply. */
  waiting: string[];
}

export interface RelayStateOptions {
  /** Produces a session's token (`secret@host:port`); the host knows its own address. */
  mintToken(): string;
  /** How long a blocking send waits for the reply before returning WAIT_LIMIT_NOTE. */
  waitLimitMs?: number;
}

export interface RelayState {
  /** Register a local session; the token is minted once and kept on later calls. */
  register(session: { sessionId: string; provider: string; role: string }): Registration;
  findByToken(token: string): Registration | undefined;
  /** Let `sessionId` reach `counterpart`; both ways when the counterpart is registered here. */
  bind(sessionId: string, counterpart: Binding): void;
  bindingsOf(sessionId: string): Binding[];
  connect(sessionId: string, connection: Connection): void;
  disconnect(sessionId: string): void;
  /** Remove a local session; returns the remote bindings it had so their relays can be told. */
  unregister(sessionId: string): Binding[];
  /** A counterpart on another relay left: drop it everywhere here and fail sessions waiting on it. */
  dropCounterpart(sessionId: string): void;
  send(options: SendOptions): Promise<string>;
  /** Deliver to a local session with the waiting/attending rules; used for messages from peer relays. */
  deliver(target: string, message: string, from: Sender, delivery: Delivery): Promise<void>;
  snapshot(): RelaySnapshot;
  /** Unregister every session: waiting sends are rejected, all tables emptied. */
  clear(): void;
}

interface Waiting {
  /** When the send was registered; strategies use it to tell whether the session still reads it. */
  since: Date;
  resolve(message: string): void;
  reject(error: Error): void;
}

export function createRelayState({ mintToken, waitLimitMs = DEFAULT_WAIT_LIMIT_MS }: RelayStateOptions): RelayState {
  const registrations = new Map<string, Registration>();
  const bindings = new Map<string, Map<string, Binding>>();
  const connections = new Map<string, Connection>();
  const waiting = new Map<string, Waiting>();

  function requireRegistration(sessionId: string): Registration {
    const reg = registrations.get(sessionId);
    if (!reg) throw new Error(`Session is not registered: ${sessionId}`);
    return reg;
  }

  function bindingsMap(sessionId: string): Map<string, Binding> {
    let map = bindings.get(sessionId);
    if (!map) bindings.set(sessionId, (map = new Map()));
    return map;
  }

  function failWaiting(sessionId: string, reason: string): void {
    const w = waiting.get(sessionId);
    if (!w) return;
    waiting.delete(sessionId);
    w.reject(new Error(reason));
  }

  /** Close a session's open wait with a note, if it has one. */
  function endWaiting(sessionId: string, note: string): void {
    const w = waiting.get(sessionId);
    if (!w) return;
    waiting.delete(sessionId);
    w.resolve(note);
  }

  /** Open a wait for `sessionId`; it ends with the reply, a note, an error, or the wait limit. */
  function startWaiting(sessionId: string): Promise<string> {
    // A session that sends again is no longer reading its previous call (Codex has one
    // turn at a time and its client gives up on a call after 300 s), so the new send takes over.
    endWaiting(sessionId, SUPERSEDED_WAIT_NOTE);
    return new Promise<string>((resolve, reject) => {
      const entry: Waiting = { since: new Date(), resolve, reject };
      waiting.set(sessionId, entry);
      const timer = setTimeout(() => {
        if (waiting.get(sessionId) === entry) endWaiting(sessionId, waitLimitNote(waitLimitMs));
      }, waitLimitMs);
      timer.unref();
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        fn(value);
      };
      entry.resolve = settle(resolve);
      entry.reject = settle(reject);
    });
  }

  /** Remove `counterpart` from every local session's bindings, failing those waiting on it. */
  function forget(counterpart: string): void {
    for (const [sessionId, map] of bindings) {
      if (map.delete(counterpart)) failWaiting(sessionId, `Counterpart unregistered: ${counterpart}`);
    }
  }

  function resolveTarget(self: Registration, target: string, role: string): string {
    const mine = bindingsMap(self.sessionId);
    if (mine.has(target)) return target;
    const candidates = [...mine.values()].filter(
      (b) => (target === "" || b.provider === target) && (role === "" || b.role === role),
    );
    const what = `${target || ""} session`.trim();
    const withRole = role ? ` with role "${role}"` : "";
    if (candidates.length === 0) throw new Error(`No bound ${what}${withRole}; register with its token first`);
    if (candidates.length > 1) {
      throw new Error(
        `Several bound ${what}s${withRole}: ${candidates.map((c) => c.sessionId).join(", ")}; pass one sessionId as target`,
      );
    }
    return candidates[0].sessionId;
  }

  async function deliverTo(other: string, message: string, from: Sender, delivery: Delivery): Promise<void> {
    const waitingOther = waiting.get(other);
    const connection = connections.get(other);
    // A blocked counterpart gets the message as its send's return value, unless its
    // strategy knows it stopped reading (e.g. codex ended the turn that called send).
    const reading =
      waitingOther !== undefined &&
      (connection?.attending === undefined || (await connection.attending(waitingOther.since)));
    if (waitingOther && reading) {
      waiting.delete(other);
      waitingOther.resolve(message);
      return;
    }
    if (!connection) throw new Error(`Target session has no live connection: ${other}`);
    await connection.deliver(message, from, delivery);
    if (waitingOther) {
      // Delivered elsewhere; close the stale send so its caller sees why nothing came back.
      waiting.delete(other);
      waitingOther.resolve(STALE_WAIT_NOTE);
    }
  }

  return {
    register({ sessionId, provider, role }) {
      const existing = registrations.get(sessionId);
      const registration = { sessionId, provider, role, token: existing?.token ?? mintToken() };
      registrations.set(sessionId, registration);
      return registration;
    },

    findByToken(token) {
      return [...registrations.values()].find((r) => r.token === token);
    },

    bind(sessionId, counterpart) {
      const self = requireRegistration(sessionId);
      if (counterpart.sessionId === sessionId) throw new Error(`Session ${sessionId} cannot bind to itself`);
      // Roles are unique among one session's counterparts, so send can name one by role alone.
      const mine = [...bindingsMap(sessionId).values()].find((b) => b.role === counterpart.role && b.sessionId !== counterpart.sessionId);
      if (mine) throw new Error(`Role "${counterpart.role}" is already bound to ${sessionId} by session ${mine.sessionId}; register with another role`);
      if (registrations.has(counterpart.sessionId)) {
        const theirs = [...bindingsMap(counterpart.sessionId).values()].find((b) => b.role === self.role && b.sessionId !== sessionId);
        if (theirs) throw new Error(`Role "${self.role}" is already bound to ${counterpart.sessionId} by session ${theirs.sessionId}; register with another role`);
      }
      bindingsMap(sessionId).set(counterpart.sessionId, { ...counterpart });
      if (counterpart.address === undefined && registrations.has(counterpart.sessionId)) {
        bindingsMap(counterpart.sessionId).set(sessionId, {
          sessionId,
          provider: self.provider,
          role: self.role,
          token: self.token,
        });
      }
    },

    bindingsOf(sessionId) {
      return [...(bindings.get(sessionId)?.values() ?? [])].map((b) => ({ ...b }));
    },

    connect(sessionId, connection) {
      connections.set(sessionId, connection);
    },

    disconnect(sessionId) {
      connections.delete(sessionId);
    },

    unregister(sessionId) {
      if (!registrations.has(sessionId)) return [];
      const remote = [...(bindings.get(sessionId)?.values() ?? [])].filter((b) => b.address !== undefined);
      bindings.delete(sessionId);
      forget(sessionId);
      failWaiting(sessionId, `Session unregistered: ${sessionId}`);
      registrations.delete(sessionId);
      connections.delete(sessionId);
      return remote;
    },

    dropCounterpart(sessionId) {
      forget(sessionId);
      connections.delete(sessionId);
    },

    snapshot() {
      return {
        registrations: [...registrations.values()],
        bindings: [...bindings]
          .filter(([, map]) => map.size > 0)
          .map(([sessionId, map]) => ({
            sessionId,
            counterparts: [...map.values()].map(({ sessionId, provider, role, address }) => ({
              sessionId,
              provider,
              role,
              ...(address === undefined ? {} : { address }),
            })),
          })),
        connected: [...connections.keys()],
        waiting: [...waiting.keys()],
      };
    },

    clear() {
      for (const sessionId of [...registrations.keys()]) this.unregister(sessionId);
      for (const sessionId of [...waiting.keys()]) failWaiting(sessionId, "Relay state cleared");
      bindings.clear();
      connections.clear();
    },

    async send({ message, selfSessionId, target = "", role = "", urgent = false, wait = true }) {
      const self = requireRegistration(selfSessionId);
      if (!target && !role) throw new Error("target or role is required: the counterpart's role, provider or sessionId");
      const own = connections.get(selfSessionId);
      if (!own) throw new Error(`Sender session has no live connection: ${selfSessionId}`);
      const other = resolveTarget(self, target, role);

      // Register our own wait before delivering, so a counterpart that answers
      // immediately finds us waiting instead of trying to push.
      const reply: Promise<string> = own.waitsForReply && wait ? startWaiting(selfSessionId) : Promise.resolve("");

      try {
        await deliverTo(other, message, { sessionId: selfSessionId, provider: self.provider, role: self.role }, { urgent });
      } catch (error) {
        waiting.delete(selfSessionId);
        throw error;
      }
      return reply;
    },

    deliver(target, message, from, delivery) {
      return deliverTo(target, message, from, delivery);
    },
  };
}
