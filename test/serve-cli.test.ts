import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("the serve CLI starts a usable HTTP MCP proxy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-serve-"));
  const fixture = path.resolve("test/fixtures/fake-codex-app-server.js");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.resolve("src/cli.ts"),
      "serve",
      "--store",
      path.join(directory, "bridge.sqlite"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--codex-command",
      process.execPath,
      "--codex-arg",
      fixture,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const client = new Client({ name: "codex", version: "1.0.0" });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const started = await new Promise<{ url: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`serve exited with ${code}: ${stderr}`)),
      );
      child.stdout.once("data", (chunk) => resolve(JSON.parse(chunk.toString())));
    });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("/mcp/codex/codex-thread-1", started.url),
      ),
    );
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["send"],
    );
  } finally {
    await client.close().catch(() => {});
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
});
