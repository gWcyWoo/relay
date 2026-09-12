import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createRelayState,
  STALE_WAIT_NOTE,
  SUPERSEDED_WAIT_NOTE,
  waitLimitNote,
  type Connection,
  type Delivery,
  type RelayState,
  type Sender,
} from "../src/relay-state.ts";

function pushConnection(provider = "claude") {
  const deliver = mock.fn(async (_message: string, _from: Sender, _delivery: Delivery) => {});
  const connection: Connection = { provider, deliver, waitsForReply: false };
  return { connection, deliver };
}

const waitOnly: Connection = {
  provider: "codex",
  waitsForReply: true,
  async deliver() {
    throw new Error("codex cannot receive pushes");
  },
};

/** Tokens are minted by the host; here they are predictable. */
function newRelay(waitLimitMs?: number) {
  let n = 0;
  return createRelayState({ mintToken: () => `t${++n}@127.0.0.1:8765`, waitLimitMs });
}

describe("relay state: registration and tokens", () => {
  it("register returns the session's own token and keeps it across re-registers", () => {
    const relay = newRelay();
    const first = relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    assert.equal(first.token, "t1@127.0.0.1:8765");
    const again = relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    assert.equal(again.token, "t1@127.0.0.1:8765");
    assert.equal(relay.findByToken("t1@127.0.0.1:8765")?.sessionId, "cl");
    assert.equal(relay.findByToken("nope@127.0.0.1:8765"), undefined);
  });

  it("re-registering with a new role updates the role but not the token", () => {
    const relay = newRelay();
    relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    const updated = relay.register({ sessionId: "cl", provider: "claude", role: "architect" });
    assert.equal(updated.role, "architect");
    assert.equal(updated.token, "t1@127.0.0.1:8765");
  });
});

describe("relay state: bindings", () => {
  let relay: RelayState;
  beforeEach(() => {
    relay = newRelay();
    relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    relay.register({ sessionId: "cx", provider: "codex", role: "" });
  });

  it("binding to a local session is written on both sides", () => {
    relay.bind("cx", { sessionId: "cl", provider: "claude", role: "review", token: "t1@127.0.0.1:8765" });
    assert.deepEqual(relay.bindingsOf("cx").map((b) => b.sessionId), ["cl"]);
    assert.deepEqual(relay.bindingsOf("cl"), [
      { sessionId: "cx", provider: "codex", role: "", token: "t2@127.0.0.1:8765" },
    ]);
  });

  it("binding to a remote session is written on this side only, with its address", () => {
    relay.bind("cl", {
      sessionId: "rx",
      provider: "codex",
      role: "executor",
      token: "r1@192.168.1.9:8765",
      address: "http://192.168.1.9:8765",
    });
    assert.deepEqual(relay.bindingsOf("cl").map((b) => [b.sessionId, b.address]), [["rx", "http://192.168.1.9:8765"]]);
    assert.deepEqual(relay.bindingsOf("rx"), []);
  });

  it("binding twice is idempotent and binding to itself is refused", () => {
    const cl = { sessionId: "cl", provider: "claude", role: "review", token: "t1@127.0.0.1:8765" };
    relay.bind("cx", cl);
    relay.bind("cx", cl);
    assert.equal(relay.bindingsOf("cx").length, 1);
    assert.throws(() => relay.bind("cl", cl), /cannot bind to itself/);
    assert.throws(
      () => relay.bind("ghost", cl),
      /Session is not registered: ghost/,
    );
  });
});

describe("relay state: send", () => {
  let relay: RelayState;
  beforeEach(() => {
    relay = newRelay();
    relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    relay.register({ sessionId: "cx", provider: "codex", role: "" });
    relay.connect("cx", waitOnly);
    relay.bind("cx", { sessionId: "cl", provider: "claude", role: "review", token: "t1@127.0.0.1:8765" });
  });

  it("finds the counterpart among the sender's bindings by provider and role", async () => {
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);
    const pending = relay.send({ message: "review this", selfSessionId: "cx", target: "claude", role: "review" });
    assert.deepEqual(deliver.mock.calls[0].arguments, [
      "review this",
      { sessionId: "cx", provider: "codex", role: "" },
      { urgent: false },
    ]);
    await relay.send({ message: "looks good", selfSessionId: "cl", target: "codex" });
    assert.equal(await pending, "looks good");
  });

  it("empty role matches any role; a bound sessionId is accepted as target", async () => {
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);
    void relay.send({ message: "a", selfSessionId: "cx", target: "claude" });
    void relay.send({ message: "b", selfSessionId: "cx", target: "cl" });
    assert.deepEqual(deliver.mock.calls.map((c) => c.arguments[0]), ["a", "b"]);
  });

  it("unbound or ambiguous counterparts fail visibly", async () => {
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "claude", role: "test" }),
      /No bound claude session with role "test"; register with its token first/,
    );
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "gemini" }),
      /No bound gemini session; register with its token first/,
    );
    await assert.rejects(relay.send({ message: "x", selfSessionId: "cx", target: "" }), /target is required/);

    relay.register({ sessionId: "cl2", provider: "claude", role: "review" });
    relay.bind("cx", { sessionId: "cl2", provider: "claude", role: "review", token: "t3@127.0.0.1:8765" });
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "claude", role: "review" }),
      /Several bound claude sessions with role "review": cl, cl2; pass one sessionId as target/,
    );
    const second = pushConnection();
    relay.connect("cl2", second.connection);
    void relay.send({ message: "x", selfSessionId: "cx", target: "cl2" });
    assert.equal(second.deliver.mock.calls.length, 1);
  });

  it("push to a provider without a push channel fails unless it is waiting", async () => {
    const { connection } = pushConnection();
    relay.connect("cl", connection);
    await assert.rejects(
      relay.send({ message: "hi", selfSessionId: "cl", target: "codex" }),
      /codex cannot receive pushes/,
    );
  });

  it("a counterpart with no live connection cannot be reached", async () => {
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "claude" }),
      /Target session has no live connection: cl/,
    );
  });

  it("binding survives disconnect; reconnect restores delivery", async () => {
    const first = pushConnection();
    relay.connect("cl", first.connection);
    void relay.send({ message: "one", selfSessionId: "cx", target: "claude" });
    relay.disconnect("cl");
    assert.equal(relay.bindingsOf("cx").length, 1);
    const second = pushConnection();
    relay.connect("cl", second.connection);
    await relay.send({ message: "ack", selfSessionId: "cl", target: "codex" });
    void relay.send({ message: "two", selfSessionId: "cx", target: "claude" });
    assert.equal(second.deliver.mock.calls[0].arguments[0], "two");
  });

  it("a second send from a waiting session delivers too and takes over the wait; the first call is told so", async () => {
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);
    const first = relay.send({ message: "one", selfSessionId: "cx", target: "claude" });
    const second = relay.send({ message: "two", selfSessionId: "cx", target: "claude" });
    assert.equal(await first, SUPERSEDED_WAIT_NOTE);
    assert.deepEqual(deliver.mock.calls.map((c) => c.arguments[0]), ["one", "two"]);
    assert.deepEqual(relay.snapshot().waiting, ["cx"]);
    await relay.send({ message: "answer", selfSessionId: "cl", target: "codex" });
    assert.equal(await second, "answer");
  });

  it("a wait ends at the limit with a note; a reply after that is pushed instead", async () => {
    const limited = newRelay(30);
    limited.register({ sessionId: "cl", provider: "claude", role: "review" });
    limited.register({ sessionId: "cx", provider: "codex", role: "" });
    const codexPush = pushConnection("codex");
    limited.connect("cx", { ...codexPush.connection, waitsForReply: true });
    limited.connect("cl", pushConnection().connection);
    limited.bind("cx", { sessionId: "cl", provider: "claude", role: "review", token: "t1@127.0.0.1:8765" });

    const pending = limited.send({ message: "q", selfSessionId: "cx", target: "claude" });
    assert.equal(await pending, waitLimitNote(30));
    assert.deepEqual(limited.snapshot().waiting, []);
    await limited.send({ message: "late answer", selfSessionId: "cl", target: "codex" });
    assert.equal(codexPush.deliver.mock.calls[0].arguments[0], "late answer");
  });

  it("a reply within the limit still returns from the send, and the limit timer is dropped", async () => {
    const limited = newRelay(1000);
    limited.register({ sessionId: "cl", provider: "claude", role: "review" });
    limited.register({ sessionId: "cx", provider: "codex", role: "" });
    limited.connect("cx", waitOnly);
    limited.connect("cl", pushConnection().connection);
    limited.bind("cx", { sessionId: "cl", provider: "claude", role: "review", token: "t1@127.0.0.1:8765" });
    const pending = limited.send({ message: "q", selfSessionId: "cx", target: "claude" });
    await limited.send({ message: "fast", selfSessionId: "cl", target: "codex" });
    assert.equal(await pending, "fast");
  });

  it("a remote counterpart is reached through its forwarding connection, never through waiting", async () => {
    const remote = pushConnection("codex");
    relay.bind("cl", {
      sessionId: "rx",
      provider: "codex",
      role: "executor",
      token: "r1@192.168.1.9:8765",
      address: "http://192.168.1.9:8765",
    });
    relay.connect("rx", remote.connection);
    relay.connect("cl", pushConnection().connection);
    assert.equal(await relay.send({ message: "do it", selfSessionId: "cl", target: "codex", role: "executor", urgent: true }), "");
    assert.deepEqual(remote.deliver.mock.calls[0].arguments, [
      "do it",
      { sessionId: "cl", provider: "claude", role: "review" },
      { urgent: true },
    ]);
  });
});

describe("relay state: leaving", () => {
  let relay: RelayState;
  beforeEach(() => {
    relay = newRelay();
    relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    relay.register({ sessionId: "cx", provider: "codex", role: "" });
    relay.connect("cx", waitOnly);
    relay.connect("cl", pushConnection().connection);
    relay.bind("cx", { sessionId: "cl", provider: "claude", role: "review", token: "t1@127.0.0.1:8765" });
  });

  it("unregister drops bindings on both sides, fails the waiting counterpart and reports remote bindings", async () => {
    relay.bind("cl", {
      sessionId: "rx",
      provider: "codex",
      role: "executor",
      token: "r1@192.168.1.9:8765",
      address: "http://192.168.1.9:8765",
    });
    const pending = relay.send({ message: "one", selfSessionId: "cx", target: "claude" });
    const dropped = relay.unregister("cl");
    await assert.rejects(pending, /Counterpart unregistered: cl/);
    assert.deepEqual(relay.bindingsOf("cx"), []);
    assert.deepEqual(relay.bindingsOf("cl"), []);
    assert.deepEqual(dropped.map((b) => b.sessionId), ["rx"]);
    assert.equal(relay.findByToken("t1@127.0.0.1:8765"), undefined);
    await assert.rejects(
      relay.send({ message: "two", selfSessionId: "cx", target: "claude" }),
      /No bound claude session; register with its token first/,
    );
  });

  it("a remote counterpart that left is dropped from every local binding and its waiter fails", async () => {
    relay.bind("cx", {
      sessionId: "rc",
      provider: "claude",
      role: "architect",
      token: "r1@192.168.1.9:8765",
      address: "http://192.168.1.9:8765",
    });
    relay.connect("rc", pushConnection().connection);
    const pending = relay.send({ message: "q", selfSessionId: "cx", target: "claude", role: "architect" });
    relay.dropCounterpart("rc");
    await assert.rejects(pending, /Counterpart unregistered: rc/);
    assert.deepEqual(relay.bindingsOf("cx").map((b) => b.sessionId), ["cl"]);
    assert.deepEqual(relay.snapshot().connected.sort(), ["cl", "cx"]);
  });

  it("snapshot shows all tables and clear empties them, failing waiters", async () => {
    const pending = relay.send({ message: "one", selfSessionId: "cx", target: "claude" });
    const snap = relay.snapshot();
    assert.deepEqual(snap.registrations.map((r) => [r.sessionId, r.token]).sort(), [
      ["cl", "t1@127.0.0.1:8765"],
      ["cx", "t2@127.0.0.1:8765"],
    ]);
    assert.deepEqual(snap.bindings.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
      { sessionId: "cl", counterparts: [{ sessionId: "cx", provider: "codex", role: "" }] },
      { sessionId: "cx", counterparts: [{ sessionId: "cl", provider: "claude", role: "review" }] },
    ]);
    assert.deepEqual(snap.connected.sort(), ["cl", "cx"]);
    assert.deepEqual(snap.waiting, ["cx"]);

    relay.clear();
    await assert.rejects(pending, /unregistered|cleared/);
    assert.deepEqual(relay.snapshot(), { registrations: [], bindings: [], connected: [], waiting: [] });
  });
});

describe("relay state: counterpart that stopped reading its send", () => {
  let relay: RelayState;
  let deliver: ReturnType<typeof mock.fn<(message: string, from: Sender, delivery: Delivery) => Promise<void>>>;
  let ended: boolean;
  beforeEach(() => {
    relay = newRelay();
    ended = false;
    deliver = mock.fn(async (_message: string, _from: Sender, _delivery: Delivery) => {});
    relay.register({ sessionId: "cx", provider: "codex", role: "" });
    relay.connect("cx", { provider: "codex", waitsForReply: true, deliver, attending: async () => !ended });
    relay.register({ sessionId: "cl", provider: "claude", role: "review" });
    relay.connect("cl", pushConnection().connection);
    relay.bind("cx", { sessionId: "cl", provider: "claude", role: "review", token: "t2@127.0.0.1:8765" });
  });

  it("a reply to a session still reading its send is returned from that send", async () => {
    const pending = relay.send({ message: "q", selfSessionId: "cx", target: "claude" });
    await relay.send({ message: "a", selfSessionId: "cl", target: "codex" });
    assert.equal(await pending, "a");
    assert.equal(deliver.mock.calls.length, 0);
  });

  it("a reply after the session stopped reading is pushed, and the stale send is told so", async () => {
    const pending = relay.send({ message: "q", selfSessionId: "cx", target: "claude" });
    ended = true;
    await relay.send({ message: "a", selfSessionId: "cl", target: "codex" });
    assert.equal(deliver.mock.calls[0].arguments[0], "a");
    assert.equal(await pending, STALE_WAIT_NOTE);
    assert.deepEqual(relay.snapshot().waiting, []);
  });

  it("if the push fails, the sender sees the error and the stale send stays open", async () => {
    const pending = relay.send({ message: "q", selfSessionId: "cx", target: "claude" });
    ended = true;
    deliver.mock.mockImplementation(async () => {
      throw new Error("composer not submitted");
    });
    await assert.rejects(relay.send({ message: "a", selfSessionId: "cl", target: "codex" }), /composer not submitted/);
    assert.deepEqual(relay.snapshot().waiting, ["cx"]);
    relay.clear();
    await assert.rejects(pending, /unregistered|cleared/);
  });

  it("deliver applies the same rules for a message that arrived from a peer relay", async () => {
    const pending = relay.send({ message: "q", selfSessionId: "cx", target: "claude" });
    await relay.deliver("cx", "from afar", { sessionId: "cl", provider: "claude", role: "review" }, { urgent: false });
    assert.equal(await pending, "from afar");
    ended = true;
    await relay.deliver("cx", "now", { sessionId: "cl", provider: "claude", role: "review" }, { urgent: true });
    assert.deepEqual(deliver.mock.calls[0].arguments.slice(0, 3), ["now", { sessionId: "cl", provider: "claude", role: "review" }, { urgent: true }]);
  });
});
