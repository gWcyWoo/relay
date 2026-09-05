/**
 * Relay core. Three tables:
 *  - registrations: sessionId -> who the session is (provider, path, role).
 *    A session is bound to its path at registration; send never takes a path.
 *  - pairs: (sessionId, target provider, role) -> counterpart sessionIds.
 *    The first send misses here and resolves the counterpart from registrations
 *    by (target provider, role, sender's path); later sends hit the pair directly.
 *    One side may have several counterparts (many Codex sessions asking one Claude reviewer).
 *  - connections: sessionId -> delivery strategy for that provider (see connections.ts)
 * Plus `waiting`: sessions blocked inside send because their strategy waits for the reply
 * (providers without a push channel); resolved by the counterpart's next send.
 */

export interface Registration {
  sessionId: string;
  provider: string;
  path: string;
  role: string;
}

export interface Sender {
  sessionId: string;
  provider: string;
  /** Pair label the sender used in this send (the role it asked for). */
  role: string;
  /** The sender's own registered role, so the receiver can address it. */
  senderRole: string;
}

export interface Connection {
  provider: string;
  /** Push a message to this session. Throws if the provider cannot receive pushes. */
  deliver(message: string, from: Sender): Promise<void>;
  /** Whether this provider's send blocks until the counterpart answers (true when it cannot be pushed to). */
  waitsForReply: boolean;
}

export interface SendOptions {
  message: string;
  selfSessionId: string;
  /**
   * Counterpart provider, e.g. "claude". Resolved at the sender's registered path together
   * with `role`. A registered sessionId (such as meta.from of a received push) is also accepted.
   */
  target: string;
  /** Counterpart role, e.g. "review"; also labels the pair on both sides. */
  role?: string;
}

export interface RelaySnapshot {
  registrations: Registration[];
  /** One row per (sessionId, target, role) side of a pair. */
  pairs: Array<{ sessionId: string; target: string; role: string; counterparts: string[] }>;
  /** Sessions with a live delivery connection. */
  connected: string[];
  /** Sessions currently blocked inside send waiting for a reply. */
  waiting: string[];
}

export interface RelayState {
  register(registration: Registration): void;
  connect(sessionId: string, connection: Connection): void;
  disconnect(sessionId: string): void;
  unregister(sessionId: string): void;
  send(options: SendOptions): Promise<string>;
  pairsOf(sessionId: string, target: string, role?: string): string[];
  snapshot(): RelaySnapshot;
  /** Unregister every session: waiting sends are rejected, all tables emptied. */
  clear(): void;
}

interface Waiting {
  resolve(message: string): void;
  reject(error: Error): void;
}

const SEP = "|";

function pairKey(sessionId: string, target: string, role: string): string {
  return [sessionId, target, role].join(SEP);
}

function splitKey(key: string): { sessionId: string; target: string; role: string } {
  const [sessionId, target, role] = key.split(SEP);
  return { sessionId, target, role };
}

export function createRelayState(): RelayState {
  const registrations = new Map<string, Registration>();
  const pairs = new Map<string, Set<string>>();
  const connections = new Map<string, Connection>();
  const waiting = new Map<string, Waiting>();

  function requireRegistration(sessionId: string): Registration {
    const reg = registrations.get(sessionId);
    if (!reg) throw new Error(`Session is not registered: ${sessionId}`);
    return reg;
  }

  function addPair(key: string, other: string): void {
    let set = pairs.get(key);
    if (!set) pairs.set(key, (set = new Set()));
    set.add(other);
  }

  function pairBothWays(self: Registration, other: Registration, role: string): void {
    addPair(pairKey(self.sessionId, other.provider, role), other.sessionId);
    addPair(pairKey(other.sessionId, self.provider, role), self.sessionId);
  }

  /** Registry lookup used when the pair table has no entry yet. */
  function findCounterpart(self: Registration, target: string, role: string): Registration {
    const candidates = [...registrations.values()].filter(
      (reg) =>
        reg.sessionId !== self.sessionId &&
        reg.provider === target &&
        reg.path === self.path &&
        (role === "" || reg.role === role),
    );
    const where = `${target} session${role ? ` with role "${role}"` : ""} at ${self.path}`;
    if (candidates.length === 0) throw new Error(`No ${where}`);
    if (candidates.length > 1) {
      throw new Error(
        `Several ${where}: ${candidates.map((c) => c.sessionId).join(", ")}; pass one sessionId as target`,
      );
    }
    return candidates[0];
  }

  function resolveTarget(self: Registration, target: string, role: string): string {
    // An explicit sessionId (e.g. meta.from of a received push) wins outright.
    const direct = registrations.get(target);
    if (direct && direct.sessionId !== self.sessionId) {
      pairBothWays(self, direct, role);
      return direct.sessionId;
    }

    const paired = pairs.get(pairKey(self.sessionId, target, role));
    if (paired && paired.size === 1) return [...paired][0];
    if (paired && paired.size > 1) {
      throw new Error(
        `Session ${self.sessionId} has several ${target} counterparts for role "${role}" (${[...paired].join(", ")}); pass one sessionId as target`,
      );
    }

    const found = findCounterpart(self, target, role);
    pairBothWays(self, found, role);
    return found.sessionId;
  }

  function failWaiting(sessionId: string, reason: string): void {
    const w = waiting.get(sessionId);
    if (!w) return;
    waiting.delete(sessionId);
    w.reject(new Error(reason));
  }

  return {
    register(registration) {
      registrations.set(registration.sessionId, registration);
    },

    connect(sessionId, connection) {
      connections.set(sessionId, connection);
    },

    disconnect(sessionId) {
      connections.delete(sessionId);
    },

    unregister(sessionId) {
      if (!registrations.has(sessionId)) return;
      for (const [key, others] of pairs) {
        if (splitKey(key).sessionId === sessionId) {
          pairs.delete(key);
        } else if (others.delete(sessionId)) {
          failWaiting(splitKey(key).sessionId, `Counterpart unregistered: ${sessionId}`);
          if (others.size === 0) pairs.delete(key);
        }
      }
      failWaiting(sessionId, `Session unregistered: ${sessionId}`);
      registrations.delete(sessionId);
      connections.delete(sessionId);
    },

    pairsOf(sessionId, target, role = "") {
      return [...(pairs.get(pairKey(sessionId, target, role)) ?? [])];
    },

    snapshot() {
      return {
        registrations: [...registrations.values()],
        pairs: [...pairs].map(([key, others]) => ({ ...splitKey(key), counterparts: [...others] })),
        connected: [...connections.keys()],
        waiting: [...waiting.keys()],
      };
    },

    clear() {
      for (const sessionId of [...registrations.keys()]) this.unregister(sessionId);
      for (const sessionId of [...waiting.keys()]) failWaiting(sessionId, "Relay state cleared");
      pairs.clear();
      connections.clear();
    },

    async send({ message, selfSessionId, target, role = "" }) {
      const self = requireRegistration(selfSessionId);
      if (!target) throw new Error("target is required: the counterpart's provider or sessionId");
      const own = connections.get(selfSessionId);
      if (!own) throw new Error(`Sender session has no live connection: ${selfSessionId}`);
      const wait = own.waitsForReply;
      const other = resolveTarget(self, target, role);

      // Register our own wait before delivering, so a counterpart that answers
      // immediately finds us waiting instead of trying to push.
      let reply: Promise<string> = Promise.resolve("");
      if (wait) {
        if (waiting.has(selfSessionId)) {
          throw new Error(`Session ${selfSessionId} is already waiting in send`);
        }
        reply = new Promise<string>((resolve, reject) => {
          waiting.set(selfSessionId, { resolve, reject });
        });
      }

      try {
        const waitingOther = waiting.get(other);
        if (waitingOther) {
          waiting.delete(other);
          waitingOther.resolve(message);
        } else {
          const connection = connections.get(other);
          if (!connection) throw new Error(`Target session has no live connection: ${other}`);
          await connection.deliver(message, {
            sessionId: selfSessionId,
            provider: self.provider,
            role,
            senderRole: self.role,
          });
        }
      } catch (error) {
        waiting.delete(selfSessionId);
        throw error;
      }

      return reply;
    },
  };
}
