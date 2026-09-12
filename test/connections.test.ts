import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { checkSetup, codexHistoryPath, codexStatePath, macDesktop, returnKeystrokeScript } from "../src/connections.ts";

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

test("codexFollowUpMode reads [desktop] followUpQueueMode from config.toml; absent means the app default, steer", async () => {
  mkdirSync(home, { recursive: true });
  const config = join(home, "config.toml");
  writeFileSync(config, "[features]\nsteer = true\n\n[desktop]\nconversationDetailMode = \"STEPS\"\nfollowUpQueueMode = \"queue\"\n");
  assert.equal(await macDesktop.codexFollowUpMode(), "queue");
  writeFileSync(config, "[desktop]\nfollowUpQueueMode = \"interrupt\"\n[other]\nfollowUpQueueMode = \"queue\"\n");
  assert.equal(await macDesktop.codexFollowUpMode(), "interrupt");
  writeFileSync(config, "[desktop]\nconversationDetailMode = \"STEPS\"\n");
  assert.equal(await macDesktop.codexFollowUpMode(), "steer");
  rmSync(config);
  assert.equal(await macDesktop.codexFollowUpMode(), "steer");
  writeFileSync(config, "[desktop]\nfollowUpQueueMode = \"later\"\n");
  await assert.rejects(macDesktop.codexFollowUpMode(), /followUpQueueMode is "later"; expected queue, steer or interrupt/);
});

test("the submit keystroke carries the requested modifiers", () => {
  assert.match(returnKeystrokeScript("ChatGPT", { command: false, shift: false }), /keystroke return$/);
  assert.match(returnKeystrokeScript("ChatGPT", { command: true, shift: false }), /keystroke return using \{command down\}$/);
  assert.match(returnKeystrokeScript("ChatGPT", { command: true, shift: true }), /keystroke return using \{command down, shift down\}$/);
});

test("codexComposerEnterBehavior reads [desktop] composerEnterBehavior; absent means enter", async () => {
  const config = join(home, "config.toml");
  writeFileSync(config, "[desktop]\ncomposerEnterBehavior = \"cmdAlways\"\n");
  assert.equal(await macDesktop.codexComposerEnterBehavior(), "cmdAlways");
  writeFileSync(config, "[desktop]\nfollowUpQueueMode = \"queue\"\n");
  assert.equal(await macDesktop.codexComposerEnterBehavior(), "enter");
  writeFileSync(config, "[desktop]\ncomposerEnterBehavior = \"tab\"\n");
  await assert.rejects(macDesktop.codexComposerEnterBehavior(), /composerEnterBehavior is "tab"; expected enter, cmdIfMultiline or cmdAlways/);
  rmSync(config);
});

test("codexTurnRunning tells whether the thread's last turn is still open, reading its rollout from the end", async () => {
  const rollout = join(home, "rollout-thread-r.jsonl");
  const db = new DatabaseSync(codexStatePath());
  db.exec("create table threads (id text primary key, rollout_path text not null)");
  db.prepare("insert into threads values (?, ?)").run("thread-r", rollout);
  db.close();
  const event = (type: string) => JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type, turn_id: "x" } }) + "\n";
  const filler = JSON.stringify({ type: "response_item", payload: { type: "message", content: "x".repeat(2000) } }) + "\n";

  writeFileSync(rollout, event("task_started") + event("task_complete"));
  assert.equal(await macDesktop.codexTurnRunning("thread-r"), false);
  writeFileSync(rollout, event("task_started") + event("task_complete") + event("task_started") + filler.repeat(100));
  assert.equal(await macDesktop.codexTurnRunning("thread-r"), true, "task_started far before the end of the file still counts");
  writeFileSync(rollout, event("task_started") + event("turn_aborted"));
  assert.equal(await macDesktop.codexTurnRunning("thread-r"), false);
  writeFileSync(rollout, "");
  assert.equal(await macDesktop.codexTurnRunning("thread-r"), false);
  await assert.rejects(macDesktop.codexTurnRunning("thread-z"), /No Codex thread thread-z in/);
  rmSync(codexStatePath());
  await assert.rejects(macDesktop.codexTurnRunning("thread-r"), /unable to open database/);
  const checks = await checkSetup("codex", macDesktop);
  assert.equal(checks.find((c) => c.name === "Codex thread state readable")?.ok, false);
});
