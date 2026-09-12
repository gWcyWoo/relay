/**
 * Relay-to-relay peering. A session's token (`secret@host:port`) names the relay holding it;
 * registering with a token that points at another relay binds the two sessions across the
 * network: bind handshake (with a call-back so both directions are known to work), message
 * forwarding, and unbind notices. Every request carries the target session's token, so only
 * a holder of that token can reach it.
 */
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import type { Binding, Connection, Delivery, Registration, RelayState, Sender } from "./relay-state.ts";

const run = promisify(execFile);

export interface PeerAddress {
  host: string;
  port: number;
}

export interface ParsedToken extends PeerAddress {
  secret: string;
}

export function parseToken(token: string): ParsedToken {
  const match = /^([^@\s]+)@([^\s:]+):(\d{1,5})$/.exec(token);
  if (!match) throw new Error(`Malformed token "${token}": expected secret@host:port`);
  return { secret: match[1], host: match[2], port: Number(match[3]) };
}

export function formatToken(secret: string, address: PeerAddress): string {
  return `${secret}@${address.host}:${address.port}`;
}

/** Name of the interface carrying the default route (macOS `route`, Linux `ip`), if it can be read. */
export async function defaultRouteInterface(): Promise<string | undefined> {
  try {
    const { stdout } =
      process.platform === "darwin"
        ? await run("route", ["-n", "get", "default"])
        : await run("ip", ["route", "show", "default"]);
    return /(?:interface:|dev)\s+(\S+)/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * This machine's non-loopback IPv4 addresses, most likely LAN address first: the default
 * route's interface, then wired/wireless interfaces (en*, eth*, wl*), then the rest (VPN
 * tunnels and the like). Which one actually answers is checked by the caller.
 */
export function lanCandidates(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  preferred?: string,
): string[] {
  const rank = (name: string) => (name === preferred ? 0 : /^(en|eth|wl)/.test(name) ? 1 : 2);
  return Object.entries(interfaces)
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((a) => a.family === "IPv4" && !a.internal)
        .map((a) => ({ name, address: a.address })),
    )
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((a) => a.address);
}

/** Whether a relay answers at this address, within a short timeout. */
export async function relayAnswersAt(address: PeerAddress, timeoutMs = 500): Promise<boolean> {
  try {
    const response = await fetch(`http://${address.host}:${address.port}/peer/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface PeerResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface PeerBindRequest {
  /** Token of the session on this relay the caller wants to bind to. */
  token: string;
  /** The caller's session, with its own token so this side can address it. */
  session: { sessionId: string; provider: string; role: string; token: string };
  /** Port of the caller's relay; its host is taken from the connection. */
  port: number;
}

export interface PeerDeliverRequest {
  token: string;
  target: string;
  from: Sender;
  message: string;
  urgent: boolean;
}

export interface PeerUnbindRequest {
  token: string;
  /** The session that left. */
  sessionId: string;
}

export interface PeeringOptions {
  relay: RelayState;
  /** Where other relays reach this one; what tokens carry. */
  self(): PeerAddress;
  /** Host names and addresses that are this machine, so a token pointing here binds locally. */
  ownHosts(): Set<string>;
}

export interface Peering {
  /** Bind a local session to the session a token points at, here or on another relay. */
  bind(session: Registration, token: string): Promise<void>;
  /** Remove a local session and tell every peer relay it was bound to. */
  unregister(sessionId: string): Promise<void>;
  handleBind(request: PeerBindRequest, callerHost: string): Promise<PeerResponse>;
  handleDeliver(request: PeerDeliverRequest): Promise<PeerResponse>;
  handleUnbind(request: PeerUnbindRequest): PeerResponse;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

async function postPeer(address: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, address), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Cannot reach the relay at ${new URL(address).host}: ${describe(error)}`);
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Relay at ${address} answered ${response.status}`);
  }
  return payload;
}

/** Delivery to a session on another relay: forward, and let that relay apply its own rules. */
function remoteConnection(address: string, token: string, target: string, provider: string): Connection {
  return {
    provider,
    waitsForReply: false,
    async deliver(message, from, { urgent }) {
      const request: PeerDeliverRequest = { token, target, from, message, urgent };
      await postPeer(address, "/peer/deliver", request);
    },
  };
}

export function createPeering({ relay, self, ownHosts }: PeeringOptions): Peering {
  function requireByToken(token: string): Registration {
    const found = relay.findByToken(token);
    if (!found) throw new Error(`No session for token ${token}`);
    return found;
  }

  function isBound(sessionId: string, counterpart: string): boolean {
    return relay.bindingsOf(sessionId).some((b) => b.sessionId === counterpart);
  }

  return {
    async bind(session, token) {
      const parsed = parseToken(token);
      if (ownHosts().has(parsed.host) && parsed.port === self().port) {
        const target = requireByToken(token);
        relay.bind(session.sessionId, { sessionId: target.sessionId, provider: target.provider, role: target.role, token });
        return;
      }
      const address = `http://${parsed.host}:${parsed.port}`;
      const request: PeerBindRequest = {
        token,
        session: { sessionId: session.sessionId, provider: session.provider, role: session.role, token: session.token },
        port: self().port,
      };
      const { session: target } = (await postPeer(address, "/peer/bind", request)) as {
        session: { sessionId: string; provider: string; role: string };
      };
      const binding: Binding = { ...target, token, address };
      relay.bind(session.sessionId, binding);
      relay.connect(target.sessionId, remoteConnection(address, token, target.sessionId, target.provider));
    },

    async unregister(sessionId) {
      const remote = relay.unregister(sessionId);
      const failures: string[] = [];
      for (const binding of remote) {
        const request: PeerUnbindRequest = { token: binding.token, sessionId };
        await postPeer(binding.address!, "/peer/unbind", request).catch((error) => {
          failures.push(`${binding.sessionId}: ${describe(error)}`);
        });
      }
      if (failures.length > 0) {
        throw new Error(`Unregistered here, but could not tell the relay of ${failures.join("; ")}`);
      }
    },

    async handleBind(request, callerHost) {
      const target = relay.findByToken(request.token);
      if (!target) return { status: 404, body: { error: `No session for token ${request.token}` } };
      if (target.sessionId === request.session.sessionId) {
        return { status: 400, body: { error: `Session ${target.sessionId} cannot bind to itself` } };
      }
      const address = `http://${callerHost}:${request.port}`;
      try {
        const ping = await fetch(new URL("/peer/ping", address));
        if (!ping.ok) throw new Error(`answered ${ping.status}`);
      } catch (error) {
        const me = self();
        return {
          status: 502,
          body: {
            error:
              `Relay ${me.host}:${me.port} cannot reach this relay at ${callerHost}:${request.port} (${describe(error)}); ` +
              "check the firewall on this machine and its advertised address",
          },
        };
      }
      const { session } = request;
      relay.bind(target.sessionId, { sessionId: session.sessionId, provider: session.provider, role: session.role, token: session.token, address });
      relay.connect(session.sessionId, remoteConnection(address, session.token, session.sessionId, session.provider));
      return { status: 200, body: { session: { sessionId: target.sessionId, provider: target.provider, role: target.role } } };
    },

    async handleDeliver(request) {
      const target = relay.findByToken(request.token);
      if (!target) return { status: 404, body: { error: `No session for token ${request.token}` } };
      if (target.sessionId !== request.target) {
        return { status: 403, body: { error: `Token does not belong to ${request.target}` } };
      }
      if (!isBound(target.sessionId, request.from.sessionId)) {
        return { status: 403, body: { error: `${request.from.sessionId} is not bound to ${target.sessionId}` } };
      }
      try {
        const delivery: Delivery = { urgent: request.urgent === true };
        await relay.deliver(target.sessionId, request.message, request.from, delivery);
      } catch (error) {
        return { status: 409, body: { error: describe(error) } };
      }
      return { status: 200, body: { delivered: true } };
    },

    handleUnbind(request) {
      const target = relay.findByToken(request.token);
      if (!target) return { status: 404, body: { error: `No session for token ${request.token}` } };
      relay.dropCounterpart(request.sessionId);
      return { status: 200, body: { unbound: true } };
    },
  };
}
