import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.id === "number") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  }
});
