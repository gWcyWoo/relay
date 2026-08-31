import type { Readable, Writable } from "node:stream";
import type { CodexJsonLineTransport } from "./codex-app-server-client.ts";

interface JsonLineTransportOptions {
  readable: Readable;
  writable: Writable;
}

export function createJsonLineTransport(
  options: JsonLineTransportOptions,
): CodexJsonLineTransport {
  const messageHandlers: Array<(message: unknown) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];
  let buffer = "";

  function report(error: Error): void {
    for (const handler of errorHandlers) handler(error);
  }

  options.readable.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const message: unknown = JSON.parse(line);
        for (const handler of messageHandlers) handler(message);
      } catch (error) {
        report(
          new Error(`Invalid JSON from Codex App Server: ${line}`, {
            cause: error,
          }),
        );
      }
    }
  });
  options.readable.on("error", report);
  options.writable.on("error", report);

  return {
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onError(handler) {
      errorHandlers.push(handler);
    },
    async send(message) {
      const line = `${JSON.stringify(message)}\n`;
      await new Promise<void>((resolve, reject) => {
        options.writable.write(line, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
