import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createRelayState,
  type Connection,
  type RelayState,
  type Sender,
} from "../src/relay-state.ts";

function pushConnection(provider = "claude") {
  const deliver = mock.fn(async (_message: string, _from: Sender) => {});
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

describe("relay state", () => {
  let relay: RelayState;
  beforeEach(() => {
    relay = createRelayState();
    relay.register({ sessionId: "cx", provider: "codex", path: "/p", role: "" });
    relay.connect("cx", waitOnly);
    relay.register({ sessionId: "cl", provider: "claude", path: "/p", role: "review" });
  });

  it("first send resolves the counterpart by provider+role at the sender's registered path and pairs both ways", async () => {
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);

    const pending = relay.send({ message: "review this", selfSessionId: "cx", target: "claude", role: "review" });
    assert.deepEqual(relay.pairsOf("cx", "claude", "review"), ["cl"]);
    assert.deepEqual(relay.pairsOf("cl", "codex", "review"), ["cx"]);
    assert.deepEqual(deliver.mock.calls[0].arguments, [
      "review this",
      { sessionId: "cx", provider: "codex", role: "review" },
    ]);

    // Claude answers with the same call shape; Codex is waiting so it gets the text back.
    await relay.send({ message: "looks good", selfSessionId: "cl", target: "codex", role: "review" });
    assert.equal(await pending, "looks good");
  });

  it("later sends hit the pair table without touching the registry", async () => {
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);
    void relay.send({ message: "one", selfSessionId: "cx", target: "claude", role: "review" });
    await relay.send({ message: "ack", selfSessionId: "cl", target: "codex", role: "review" });
    // A second reviewer at the same path would make a registry lookup ambiguous; the pair avoids it.
    relay.register({ sessionId: "cl2", provider: "claude", path: "/p", role: "review" });
    void relay.send({ message: "two", selfSessionId: "cx", target: "claude", role: "review" });
    assert.equal(deliver.mock.calls[1].arguments[0], "two");
  });

  it("registry lookup ignores other paths and other roles", async () => {
    relay.register({ sessionId: "cl-other-path", provider: "claude", path: "/q", role: "review" });
    relay.register({ sessionId: "cl-tester", provider: "claude", path: "/p", role: "test" });
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);
    void relay.send({ message: "r", selfSessionId: "cx", target: "claude", role: "review" });
    assert.deepEqual(relay.pairsOf("cx", "claude", "review"), ["cl"]);
    assert.equal(deliver.mock.calls.length, 1);
  });

  it("empty role matches any role", async () => {
    const { connection } = pushConnection();
    relay.connect("cl", connection);
    void relay.send({ message: "r", selfSessionId: "cx", target: "claude" });
    assert.deepEqual(relay.pairsOf("cx", "claude"), ["cl"]);
  });

  it("no matching counterpart fails visibly", async () => {
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "claude", role: "test" }),
      /No claude session with role "test" at \/p/,
    );
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "gemini" }),
      /No gemini session at \/p/,
    );
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "" }),
      /target is required/,
    );
  });

  it("several matching counterparts fail visibly and can be picked by sessionId", async () => {
    relay.register({ sessionId: "cl2", provider: "claude", path: "/p", role: "review" });
    const second = pushConnection();
    relay.connect("cl2", second.connection);
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "claude", role: "review" }),
      /Several claude session with role "review" at \/p: cl, cl2; pass one sessionId as target/,
    );
    void relay.send({ message: "x", selfSessionId: "cx", target: "cl2", role: "review" });
    assert.deepEqual(relay.pairsOf("cx", "claude", "review"), ["cl2"]);
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

  it("a session with no live connection cannot be reached", async () => {
    await assert.rejects(
      relay.send({ message: "x", selfSessionId: "cx", target: "claude", role: "review" }),
      /Target session has no live connection: cl/,
    );
  });

  it("registration and pair survive disconnect; reconnect restores delivery", async () => {
    const first = pushConnection();
    relay.connect("cl", first.connection);
    void relay.send({ message: "one", selfSessionId: "cx", target: "claude", role: "review" });
    relay.disconnect("cl");
    assert.deepEqual(relay.pairsOf("cx", "claude", "review"), ["cl"]);

    const second = pushConnection();
    relay.connect("cl", second.connection);
    await relay.send({ message: "ack", selfSessionId: "cl", target: "codex", role: "review" });
    void relay.send({ message: "two", selfSessionId: "cx", target: "claude", role: "review" });
    assert.equal(second.deliver.mock.calls[0].arguments[0], "two");
  });

  it("unregister drops pairs and fails the waiting counterpart", async () => {
    const { connection } = pushConnection();
    relay.connect("cl", connection);
    const pending = relay.send({ message: "one", selfSessionId: "cx", target: "claude", role: "review" });
    relay.unregister("cl");
    await assert.rejects(pending, /Counterpart unregistered: cl/);
    assert.deepEqual(relay.pairsOf("cx", "claude", "review"), []);
    assert.deepEqual(relay.pairsOf("cl", "codex", "review"), []);
  });

  it("several requesters can pair with one responder; replies name the requester via meta.from", async () => {
    const { connection, deliver } = pushConnection();
    relay.connect("cl", connection);
    relay.register({ sessionId: "cx2", provider: "codex", path: "/p", role: "" });
    relay.connect("cx2", waitOnly);

    const fromA = relay.send({ message: "from A", selfSessionId: "cx", target: "claude", role: "review" });
    const fromB = relay.send({ message: "from B", selfSessionId: "cx2", target: "claude", role: "review" });
    assert.deepEqual(relay.pairsOf("cl", "codex", "review").sort(), ["cx", "cx2"]);
    assert.deepEqual(
      deliver.mock.calls.map((c) => (c.arguments[1] as Sender).sessionId),
      ["cx", "cx2"],
    );

    await assert.rejects(
      relay.send({ message: "ok", selfSessionId: "cl", target: "codex", role: "review" }),
      /several codex counterparts for role "review" \(cx, cx2\); pass one sessionId as target/,
    );

    await relay.send({ message: "ok B", selfSessionId: "cl", target: "cx2", role: "review" });
    await relay.send({ message: "ok A", selfSessionId: "cl", target: "cx", role: "review" });
    assert.equal(await fromB, "ok B");
    assert.equal(await fromA, "ok A");

    relay.unregister("cx2");
    assert.deepEqual(relay.pairsOf("cl", "codex", "review"), ["cx"]);
  });

  it("snapshot shows all tables and clear empties them, failing waiters", async () => {
    const { connection } = pushConnection();
    relay.connect("cl", connection);
    const pending = relay.send({ message: "one", selfSessionId: "cx", target: "claude", role: "review" });

    const snap = relay.snapshot();
    assert.deepEqual(snap.registrations.map((r) => r.sessionId).sort(), ["cl", "cx"]);
    assert.deepEqual(snap.pairs.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
      { sessionId: "cl", target: "codex", role: "review", counterparts: ["cx"] },
      { sessionId: "cx", target: "claude", role: "review", counterparts: ["cl"] },
    ]);
    assert.deepEqual(snap.connected.sort(), ["cl", "cx"]);
    assert.deepEqual(snap.waiting, ["cx"]);

    relay.clear();
    await assert.rejects(pending, /unregistered|cleared/);
    assert.deepEqual(relay.snapshot(), { registrations: [], pairs: [], connected: [], waiting: [] });
  });

  it("a session cannot wait twice at once", async () => {
    const { connection } = pushConnection();
    relay.connect("cl", connection);
    void relay.send({ message: "one", selfSessionId: "cx", target: "claude", role: "review" }).catch(() => {});
    await assert.rejects(
      relay.send({ message: "again", selfSessionId: "cx", target: "claude", role: "review" }),
      /already waiting in send/,
    );
  });
});
