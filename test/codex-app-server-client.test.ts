import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCodexAppServerClient,
  type CodexJsonLineTransport,
} from "../src/codex-app-server-client.ts";

test("the Codex client initializes App Server before resuming a thread and starting a turn", async () => {
  const sent: unknown[] = [];
  let receive: (message: unknown) => void = () => {
    throw new Error("message handler was not registered");
  };

  const transport: CodexJsonLineTransport = {
    onMessage(handler) {
      receive = handler;
    },
    onError() {},
    async send(message) {
      sent.push(message);
      if ("id" in message) {
        queueMicrotask(() => receive({ id: message.id, result: {} }));
      }
    },
  };

  const client = createCodexAppServerClient(transport);
  await client.resumeThread("codex-thread-1");
  await client.startTurn("codex-thread-1", "Implement the approved design.");

  assert.deepEqual(sent, [
    {
      id: 0,
      method: "initialize",
      params: {
        clientInfo: {
          name: "relay",
          title: "Relay",
          version: "0.1.0",
        },
      },
    },
    { method: "initialized", params: {} },
    {
      id: 1,
      method: "thread/resume",
      params: { threadId: "codex-thread-1" },
    },
    {
      id: 2,
      method: "turn/start",
      params: {
        threadId: "codex-thread-1",
        input: [{ type: "text", text: "Implement the approved design." }],
      },
    },
  ]);
});
