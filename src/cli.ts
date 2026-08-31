import { fileURLToPath } from "node:url";
import { startBridgeHttpServer } from "./http-bridge-server.ts";
import { createBridgePair } from "./pair-store.ts";
import { spawnCodexAppServerClient } from "./spawn-codex-app-server.ts";

const internalStorePath =
  process.env.RELAY_STORE_PATH ??
  fileURLToPath(new URL("../.relay.sqlite", import.meta.url));

function readOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function readOptionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readAssignment(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function readRepeatedOption(args: string[], name: string): string[] {
  return args.flatMap((value, index) =>
    value === name && args[index + 1] ? [args[index + 1]] : [],
  );
}

function readEndpoints(args: string[]): [string, string] {
  const storeIndex = args.indexOf("--store");
  const endpoints = args.filter(
    (_value, index) => index !== storeIndex && index !== storeIndex + 1,
  );
  if (endpoints.length !== 2) {
    throw new Error("pair requires exactly two endpoints");
  }
  return [endpoints[0], endpoints[1]];
}

function pair(args: string[]): void {
  const storePath = readOptionalOption(args, "--store") ?? internalStorePath;
  const claudeSessionId = readAssignment(args, "--claude");
  const codexThreadId = readAssignment(args, "--codex");
  const usesShortOptions = args.some(
    (value) => value.startsWith("--claude") || value.startsWith("--codex"),
  );
  if (usesShortOptions && !claudeSessionId) {
    throw new Error("Missing required option: --claude");
  }
  if (usesShortOptions && !codexThreadId) {
    throw new Error("Missing required option: --codex");
  }
  const [leftEndpoint, rightEndpoint] = usesShortOptions
    ? [`claude:${claudeSessionId}`, `codex:${codexThreadId}`]
    : readEndpoints(args);
  const bridgeId = createBridgePair({
    storePath,
    leftEndpoint,
    rightEndpoint,
  });

  process.stdout.write(`${JSON.stringify({ bridgeId })}\n`);
}

async function serve(args: string[]): Promise<void> {
  const storePath = readOptionalOption(args, "--store") ?? internalStorePath;
  const host = readOptionalOption(args, "--host") ?? "127.0.0.1";
  const portText = readOptionalOption(args, "--port") ?? "8765";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portText}`);
  }
  const command = readOptionalOption(args, "--codex-command") ?? "codex";
  const commandArgs = readRepeatedOption(args, "--codex-arg");
  const appServer = spawnCodexAppServerClient({
    command,
    args: commandArgs.length > 0 ? commandArgs : ["app-server"],
  });
  const bridge = await startBridgeHttpServer({
    storePath,
    codexAppServer: appServer.client,
    host,
    port,
  });
  process.stdout.write(`${JSON.stringify({ url: bridge.url.toString() })}\n`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await bridge.close();
  await appServer.close();
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "pair") {
    pair(args);
    return;
  }
  if (command === "serve") {
    await serve(args);
    return;
  }
  throw new Error(`Unknown command: ${command ?? ""}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
