import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawnCodexAppServerClient } from "../src/spawn-codex-app-server.ts";

test("a spawned App Server process can receive Codex client operations", async () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/fake-codex-app-server.js", import.meta.url),
  );
  const appServer = spawnCodexAppServerClient({
    command: process.execPath,
    args: [fixture],
  });

  try {
    await appServer.client.resumeThread("codex-thread-1");
    await appServer.client.startTurn("codex-thread-1", "Build it.");
  } finally {
    await appServer.close();
  }
});
