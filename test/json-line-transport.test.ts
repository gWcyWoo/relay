import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createJsonLineTransport } from "../src/json-line-transport.ts";

test("the JSON-line transport writes requests and reconstructs fragmented responses", async () => {
  const appServerStdout = new PassThrough();
  const appServerStdin = new PassThrough();
  const transport = createJsonLineTransport({
    readable: appServerStdout,
    writable: appServerStdin,
  });
  const messages: unknown[] = [];
  transport.onMessage((message) => messages.push(message));
  transport.onError((error) => {
    throw error;
  });

  const output = new Promise<string>((resolve) => {
    appServerStdin.once("data", (chunk) => resolve(chunk.toString()));
  });
  await transport.send({ id: 1, method: "thread/resume", params: {} });
  assert.equal(
    await output,
    '{"id":1,"method":"thread/resume","params":{}}\n',
  );

  appServerStdout.write('{"id":1,"res');
  appServerStdout.write('ult":{}}\n');
  assert.deepEqual(messages, [{ id: 1, result: {} }]);
});
