import { checkSetup, knownProviders, macDesktop, type SetupCheck } from "./connections.ts";
import { startBridgeHttpServer } from "./http-bridge-server.ts";

function readOptionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function formatSetup(provider: string, checks: SetupCheck[]): string {
  const lines = checks.map((c) => {
    const mark = c.ok === true ? "ok  " : c.ok === false ? "FAIL" : "?   ";
    return `  ${mark} ${c.name}${c.ok === true ? "" : `\n       fix: ${c.fix}`}`;
  });
  return [`${provider}:`, ...(lines.length ? lines : ["  (no requirements)"])].join("\n");
}

/** Check every provider's requirements on this machine and print how to fix what is missing. */
async function doctor(): Promise<void> {
  let failed = false;
  for (const provider of knownProviders()) {
    const checks = await checkSetup(provider, macDesktop);
    if (checks.some((c) => c.ok === false)) failed = true;
    process.stdout.write(`${formatSetup(provider, checks)}\n`);
  }
  if (failed) process.exitCode = 1;
}

async function serve(args: string[]): Promise<void> {
  const host = readOptionalOption(args, "--host") ?? "127.0.0.1";
  const portText = readOptionalOption(args, "--port") ?? "8765";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portText}`);
  }
  const bridge = await startBridgeHttpServer({ host, port });
  process.stdout.write(`${JSON.stringify({ url: bridge.url.toString() })}\n`);
  // Real setup failures are reported at startup so nobody discovers them at delivery time.
  for (const provider of knownProviders()) {
    const failed = (await checkSetup(provider, macDesktop)).filter((c) => c.ok === false);
    if (failed.length > 0) process.stderr.write(`setup: ${formatSetup(provider, failed)}\n`);
  }

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await bridge.close();
}

function adminUrl(args: string[]): URL {
  const base = readOptionalOption(args, "--url") ?? "http://127.0.0.1:8765";
  return new URL("/admin/state", base);
}

async function callAdmin(url: URL, method: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method });
  } catch (error) {
    throw new Error(`Relay is not reachable at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Relay answered ${response.status} for ${method} ${url.pathname}`);
  return response.json();
}

/** Print the running server's registrations, pairs, connections and waiting sends. */
async function status(args: string[]): Promise<void> {
  const state = await callAdmin(adminUrl(args), "GET");
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

/** Drop every registration and pair on the running server; waiting sends get an error. */
async function clear(args: string[]): Promise<void> {
  const result = await callAdmin(adminUrl(args), "DELETE");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const USAGE = `Usage:
  relay serve  [--host 127.0.0.1] [--port 8765]   start the relay server (prints setup problems)
  relay doctor                                    check each provider's requirements on this machine
  relay status [--url http://127.0.0.1:8765]      show registrations, pairs, connections, waiting sends
  relay clear  [--url http://127.0.0.1:8765]      remove all registrations and pairs`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "serve":
      return serve(args);
    case "status":
      return status(args);
    case "clear":
      return clear(args);
    case "doctor":
      return doctor();
    default:
      throw new Error(`Unknown command: ${command ?? ""}\n${USAGE}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
