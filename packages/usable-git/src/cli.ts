#!/usr/bin/env bun
import { operationSchema } from "./contracts/v1.ts";
import { resolve } from "node:path";
import { runDoctor, type RunDoctorOptions } from "./doctor/index.ts";
import { installClients, type InstallClient, type InstallClientsOptions } from "./install/index.ts";
import { executeOperation } from "./service.ts";

const usage = `Usage:
  usable-git inspect|review|history|publish|push --input -
  usable-git mcp
  usable-git install --clients all [--force]
  usable-git doctor --clients all
`;

type CliDependencies = {
  executablePath: string;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
  installClients: (options: InstallClientsOptions) => ReturnType<typeof installClients>;
  runDoctor: (options: RunDoctorOptions) => ReturnType<typeof runDoctor>;
};

const defaultDependencies = (): CliDependencies => ({
  executablePath: resolve(process.argv[1] ?? "usable-git"),
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
  installClients,
  runDoctor,
});

const failUsage = (writeStderr: CliDependencies["writeStderr"], message?: string) => {
  if (message) writeStderr(`${message}\n`);
  writeStderr(usage);
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

const selectedClients = (value: string): "all" | InstallClient[] =>
  value === "all" ? "all" : value.split(",") as InstallClient[];

export const runCli = async (
  args = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
) => {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const command = args[0];
  const parsedOperation = operationSchema.safeParse(command);
  if (parsedOperation.success) {
    let input: unknown;
    try {
      input = await readStdinRequest(args.slice(1));
    } catch (error) {
      dependencies.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return failUsage(dependencies.writeStderr);
    }
    const envelope = await executeOperation(parsedOperation.data, input, { transport: "cli" });
    dependencies.writeStdout(`${JSON.stringify(envelope)}\n`);
    return envelope.ok ? 0 : 2;
  }

  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.ts");
    await runMcpServer();
    return 0;
  }

  if (command === "install") {
    const clientsIndex = args.indexOf("--clients");
    const clientsValue = clientsIndex === -1 ? undefined : args[clientsIndex + 1];
    if (!clientsValue) return failUsage(dependencies.writeStderr, "install requires --clients");
    try {
      const results = await dependencies.installClients({
        clients: selectedClients(clientsValue),
        executablePath: dependencies.executablePath,
        force: args.includes("--force"),
      });
      dependencies.writeStdout(`${JSON.stringify({ ok: true, command: "install", results })}\n`);
      return 0;
    } catch (error) {
      dependencies.writeStdout(`${JSON.stringify({
        ok: false,
        command: "install",
        error: {
          code: error && typeof error === "object" && "code" in error ? error.code : "install_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`);
      return 2;
    }
  }

  if (command === "doctor") {
    const clientsIndex = args.indexOf("--clients");
    const clientsValue = clientsIndex === -1 ? undefined : args[clientsIndex + 1];
    if (!clientsValue) return failUsage(dependencies.writeStderr, "doctor requires --clients");
    try {
      const report = await dependencies.runDoctor({
        clients: selectedClients(clientsValue),
        executablePath: dependencies.executablePath,
      });
      dependencies.writeStdout(`${JSON.stringify(report)}\n`);
      return report.ok ? 0 : 2;
    } catch (error) {
      dependencies.writeStdout(`${JSON.stringify({
        version: "v1",
        ok: false,
        command: "doctor",
        error: {
          code: "doctor_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`);
      return 2;
    }
  }

  return failUsage(dependencies.writeStderr, command ? `Unknown command: ${command}` : undefined);
};

if (import.meta.main) {
  process.exitCode = await runCli();
}
