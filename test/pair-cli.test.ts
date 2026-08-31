import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("bin/relay.js");

test("pairing a Claude session with a Codex session returns a five-digit bridge id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-pair-"));
  const storePath = path.join(directory, "bridge.sqlite");

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "pair",
      "--codex=codex-thread-1",
      "--claude=claude-session-1",
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, RELAY_STORE_PATH: storePath },
    },
  );

  const result = JSON.parse(stdout) as { bridgeId?: string };
  assert.match(result.bridgeId ?? "", /^\d{5}$/);
});

test("short pairing reports a missing Claude session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "relay-pair-error-"));
  const storePath = path.join(directory, "bridge.sqlite");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "pair", "--codex=codex-thread-1"], {
      cwd: path.resolve("."),
      env: { ...process.env, RELAY_STORE_PATH: storePath },
    }),
    /Missing required option: --claude/,
  );
});
