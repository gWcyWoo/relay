import type { CodexAppServerClient } from "./codex-adapter.ts";

type JsonObject = Record<string, unknown>;

export interface CodexJsonLineTransport {
  send(message: JsonObject): Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  onError(handler: (error: Error) => void): void;
}

interface PendingRequest {
  resolve(): void;
  reject(error: Error): void;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function appServerError(value: unknown): Error {
  if (isObject(value) && typeof value.message === "string") {
    return new Error(`Codex App Server: ${value.message}`);
  }
  return new Error(`Codex App Server request failed: ${JSON.stringify(value)}`);
}

export function createCodexAppServerClient(
  transport: CodexJsonLineTransport,
): CodexAppServerClient {
  let nextId = 0;
  let initialization: Promise<void> | undefined;
  const pending = new Map<number, PendingRequest>();

  transport.onMessage((message) => {
    if (!isObject(message) || typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if ("error" in message) {
      request.reject(appServerError(message.error));
    } else {
      request.resolve();
    }
  });

  transport.onError((error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  async function request(method: string, params: JsonObject): Promise<void> {
    const id = nextId++;
    const response = new Promise<void>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    try {
      await transport.send({ id, method, params });
    } catch (error) {
      pending.delete(id);
      throw error;
    }
    await response;
  }

  async function initialize(): Promise<void> {
    await request("initialize", {
      clientInfo: {
        name: "relay",
        title: "Relay",
        version: "0.1.0",
      },
    });
    await transport.send({ method: "initialized", params: {} });
  }

  function ensureInitialized(): Promise<void> {
    initialization ??= initialize();
    return initialization;
  }

  return {
    async resumeThread(threadId) {
      await ensureInitialized();
      await request("thread/resume", { threadId });
    },
    async startTurn(threadId, message) {
      await ensureInitialized();
      await request("turn/start", {
        threadId,
        input: [{ type: "text", text: message }],
      });
    },
  };
}
