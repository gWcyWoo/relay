import { spawn } from "node:child_process";
import type { CodexAppServerClient } from "./codex-adapter.ts";
import { createCodexAppServerClient } from "./codex-app-server-client.ts";
import { createJsonLineTransport } from "./json-line-transport.ts";

interface SpawnOptions {
  command?: string;
  args?: string[];
}

export interface SpawnedCodexAppServer {
  client: CodexAppServerClient;
  close(): Promise<void>;
}

export function spawnCodexAppServerClient(
  options: SpawnOptions = {},
): SpawnedCodexAppServer {
  const child = spawn(options.command ?? "codex", options.args ?? ["app-server"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const transport = createJsonLineTransport({
    readable: child.stdout,
    writable: child.stdin,
  });

  return {
    client: createCodexAppServerClient(transport),
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill();
      await exited;
    },
  };
}
