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

type JsonOperation = "inspect" | "review" | "history" | "publish" | "push";

const allowedFlags: Record<JsonOperation, Set<string>> = {
  inspect: new Set(["repo-path", "file"]),
  review: new Set(["repo-path", "file", "cursor", "byte-cap"]),
  history: new Set(["repo-path", "ref", "limit", "cursor", "byte-cap"]),
  publish: new Set([
    "repo-path", "file", "message", "request-id", "expected-head", "expected-fingerprint",
  ]),
  push: new Set([
    "repo-path", "remote", "source-ref", "target-ref", "request-id", "expected-source-oid",
    "mode", "expected-target-oid",
  ]),
};

const parseFlags = (operation: JsonOperation, args: string[]) => {
  if (!args.includes("--json")) throw new Error("JSON flag mode requires --json");
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") continue;
    if (!token.startsWith("--")) throw new Error(`Unexpected JSON argument: ${token}`);
    const key = token.slice(2);
    if (!allowedFlags[operation].has(key)) throw new Error(`Unknown ${operation} flag: ${token}`);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${token} requires a value`);
    values.set(key, [...(values.get(key) ?? []), value]);
    index += 1;
  }
  return values;
};

const one = (values: Map<string, string[]>, key: string) => {
  const matches = values.get(key) ?? [];
  if (matches.length > 1) throw new Error(`--${key} may be supplied only once`);
  return matches[0];
};

const required = (values: Map<string, string[]>, key: string) => {
  const value = one(values, key);
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
};

const integer = (values: Map<string, string[]>, key: string) => {
  const value = one(values, key);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new Error(`--${key} must be an integer`);
  return Number(value);
};

const optionalFiles = (values: Map<string, string[]>) => {
  const files = values.get("file");
  return files ? { files } : {};
};

export const parseJsonRequest = (operation: JsonOperation, args: string[]): unknown => {
  const values = parseFlags(operation, args);
  const repoPath = required(values, "repo-path");
  if (operation === "inspect") return { repoPath, ...optionalFiles(values) };
  if (operation === "review") {
    return {
      repoPath,
      ...optionalFiles(values),
      ...(one(values, "cursor") ? { cursor: one(values, "cursor") } : {}),
      ...(integer(values, "byte-cap") !== undefined ? { byteCap: integer(values, "byte-cap") } : {}),
    };
  }
  if (operation === "history") {
    return {
      repoPath,
      ...(one(values, "ref") ? { ref: one(values, "ref") } : {}),
      ...(integer(values, "limit") !== undefined ? { limit: integer(values, "limit") } : {}),
      ...(one(values, "cursor") ? { cursor: one(values, "cursor") } : {}),
      ...(integer(values, "byte-cap") !== undefined ? { byteCap: integer(values, "byte-cap") } : {}),
    };
  }
  if (operation === "publish") {
    const fingerprints = Object.fromEntries((values.get("expected-fingerprint") ?? []).map((entry) => {
      const separator = entry.lastIndexOf("=");
      if (separator <= 0) throw new Error("--expected-fingerprint requires path=sha256");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    const expectedHead = required(values, "expected-head");
    return {
      repoPath,
      files: values.get("file") ?? [],
      message: required(values, "message"),
      requestId: required(values, "request-id"),
      expectedHead: expectedHead === "unborn"
        ? { kind: "unborn" }
        : { kind: "oid", oid: expectedHead },
      expectedFingerprints: fingerprints,
    };
  }
  const mode = required(values, "mode");
  return {
    repoPath,
    remote: required(values, "remote"),
    sourceRef: required(values, "source-ref"),
    targetRef: required(values, "target-ref"),
    requestId: required(values, "request-id"),
    expectedSourceOid: required(values, "expected-source-oid"),
    mode: mode === "force-with-lease"
      ? { kind: mode, expectedTargetOid: required(values, "expected-target-oid") }
      : { kind: mode },
  };
};

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
      input = args.includes("--json")
        ? parseJsonRequest(parsedOperation.data, args.slice(1))
        : await readStdinRequest(args.slice(1));
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
