#!/usr/bin/env bun
import { operationSchema } from "./contracts/v1.ts";
import { executeOperation } from "./service.ts";

const usage = `Usage:
  usable-git inspect|review|history|publish|push --input -
  usable-git mcp
  usable-git install --clients all [--force]
  usable-git doctor --clients all
`;

const failUsage = (message?: string) => {
  if (message) console.error(message);
  console.error(usage);
  return 64;
};

const readStdinRequest = async (args: string[]) => {
  const inputIndex = args.indexOf("--input");
  if (inputIndex === -1 || args[inputIndex + 1] !== "-") {
    throw new Error("Operation commands require --input -");
  }
  const serialized = await Bun.stdin.text();
  if (!serialized.trim()) throw new Error("stdin request is empty");
  return JSON.parse(serialized) as unknown;
};

export const runCli = async (args = process.argv.slice(2)) => {
  const command = args[0];
  const parsedOperation = operationSchema.safeParse(command);
  if (parsedOperation.success) {
    let input: unknown;
    try {
      input = await readStdinRequest(args.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return failUsage();
    }
    const envelope = await executeOperation(parsedOperation.data, input, { transport: "cli" });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return envelope.ok ? 0 : 2;
  }

  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.ts");
    await runMcpServer();
    return 0;
  }

  return failUsage(command ? `Unknown command: ${command}` : undefined);
};

if (import.meta.main) {
  process.exitCode = await runCli();
}
