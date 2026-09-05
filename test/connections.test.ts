import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { checkSetup, codexHistoryPath, macDesktop } from "../src/connections.ts";

// Codex's thread_turns table, as written by Codex 0.153 (a row appears when a turn ends).
const SCHEMA = `create table thread_turns (
  thread_id text not null, turn_id text not null, rollout_ordinal integer not null,
  status text not null, error_json text, started_at integer, completed_at integer, duration_ms integer,
  primary key (thread_id, turn_id))`;

let home: string;
const savedHome = process.env.CODEX_HOME;
before(() => {
  home = mkdtempSync(join(tmpdir(), "relay-codex-"));
  process.env.CODEX_HOME = home;
});
after(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function seed(rows: Array<[thread: string, turn: string, status: string, started: number, completed: number]>) {
  const db = new DatabaseSync(codexHistoryPath());
  db.exec(SCHEMA);
  const insert = db.prepare("insert into thread_turns values (?, ?, ?, ?, null, ?, ?, ?)");
  rows.forEach(([thread, turn, status, started, completed], i) =>
    insert.run(thread, turn, i, status, started, completed, (completed - started) * 1000),
  );
  db.close();
}

test("codexTurnEnded reads the turn covering the send from Codex's thread history", async () => {
  // The case seen on 2026-09-05: send at 08:48:54Z inside a turn that ran 08:48:17Z–08:51:11Z.
  seed([
    ["thread-a", "turn-1", "completed", 1788598097, 1788598271],
    ["thread-a", "turn-0", "interrupted", 1788590000, 1788590100],
    ["thread-b", "turn-x", "completed", 1788598097, 1788598271],
  ]);
  const sendAt = new Date(Date.UTC(2026, 8, 5, 8, 48, 54));
  assert.equal(await macDesktop.codexTurnEnded("thread-a", sendAt), true);
  // A send from a turn that has not ended yet has no covering row.
  assert.equal(await macDesktop.codexTurnEnded("thread-a", new Date(Date.UTC(2026, 8, 5, 9, 0, 0))), false);
  // Other threads' turns do not count.
  assert.equal(await macDesktop.codexTurnEnded("thread-c", sendAt), false);
  // An interrupted turn (user pressed stop) also ended.
  assert.equal(await macDesktop.codexTurnEnded("thread-a", new Date(1788590050 * 1000)), true);
});

test("a missing Codex history is a visible error and a failing setup check", async () => {
  rmSync(codexHistoryPath());
  await assert.rejects(macDesktop.codexTurnEnded("thread-a", new Date()), /unable to open database/);
  const checks = await checkSetup("codex", macDesktop);
  const history = checks.find((c) => c.name === "Codex thread history readable");
  assert.equal(history?.ok, false);
  assert.match(history?.fix ?? "", /thread_history_1\.sqlite/);
});
