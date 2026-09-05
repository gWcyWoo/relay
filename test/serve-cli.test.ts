import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("the serve CLI starts a usable HTTP MCP proxy", async () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.resolve("src/cli.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const claude = new Client({ name: "claude", version: "1.0.0" });
  const codex = new Client({ name: "codex", version: "1.0.0" });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  try {
    const started = await new Promise<{ url: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`serve exited with ${code}: ${stderr}`)),
      );
      child.stdout.once("data", (chunk: Buffer) =>
        resolve(JSON.parse(chunk.toString())),
      );
    });

    await claude.connect(
      new StreamableHTTPClientTransport(new URL("/mcp/claude", started.url)),
    );
    await codex.connect(
      new StreamableHTTPClientTransport(new URL("/mcp/codex", started.url)),
    );

    const expected = ["register", "send", "unregister"];
    const claudeTools = await claude.listTools();
    assert.deepEqual(claudeTools.tools.map((t) => t.name).sort(), expected);

    const codexTools = await codex.listTools();
    assert.deepEqual(codexTools.tools.map((t) => t.name).sort(), expected);
  } finally {
    await Promise.allSettled([claude.close(), codex.close()]);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
});
