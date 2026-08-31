import type { DeliveryReceipt, SessionAdapter } from "./bridge-proxy.ts";

export interface CodexAppServerClient {
  resumeThread(threadId: string): Promise<void>;
  startTurn(threadId: string, message: string): Promise<void>;
}

export function createCodexAdapter(
  appServer: CodexAppServerClient,
): SessionAdapter {
  return {
    provider: "codex",
    async deliver(delivery): Promise<DeliveryReceipt> {
      await appServer.resumeThread(delivery.targetSessionId);
      await appServer.startTurn(delivery.targetSessionId, delivery.message);
      return { delivered: true };
    },
  };
}
