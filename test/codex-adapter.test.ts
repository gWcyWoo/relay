import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexAdapter } from "../src/codex-adapter.ts";

test("the Codex adapter resumes the paired thread and starts a turn", async () => {
  const calls: Array<{ method: string; threadId: string; message?: string }> = [];
  const adapter = createCodexAdapter({
    async resumeThread(threadId) {
      calls.push({ method: "thread/resume", threadId });
    },
    async startTurn(threadId, message) {
      calls.push({ method: "turn/start", threadId, message });
    },
  });

  const receipt = await adapter.deliver({
    bridgeId: "brg_test",
    targetSessionId: "codex-thread-1",
    message: "Implement the approved design.",
  });

  assert.deepEqual(calls, [
    { method: "thread/resume", threadId: "codex-thread-1" },
    {
      method: "turn/start",
      threadId: "codex-thread-1",
      message: "Implement the approved design.",
    },
  ]);
  assert.deepEqual(receipt, { delivered: true });
});
