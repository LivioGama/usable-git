import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  createDoctorProcessRunner,
  runDoctor,
  type DoctorClientInvoker,
  type DoctorProcessRunner,
} from "@usable-git/doctor/index.ts";
import type {
  InstallRunner,
  InstallRunnerRequest,
} from "@usable-git/install/native.ts";
import { withTempDirectory } from "./support/temp.ts";

const sourceCli = resolve(import.meta.dir, "../src/cli.ts");

const executableFixture = async (home: string) => {
  const executablePath = join(home, "bin", "usable-git");
  await mkdir(dirname(executablePath), { recursive: true });
  await writeFile(
    executablePath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(sourceCli)} "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(executablePath, 0o755);
  return executablePath;
};

const matchingInstallRunner = (executablePath: string): InstallRunner =>
  async (request: InstallRunnerRequest) => {
    if (request.command !== "codex" || request.args.join(" ") !== "mcp get usable-git --json") {
      throw new Error(`Unexpected registration request: ${JSON.stringify(request)}`);
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        transport: {
          type: "stdio",
          command: executablePath,
          args: ["mcp"],
          env: null,
        },
      }),
    };
  };

const writeMatchingConfigs = async (home: string, executablePath: string) => {
  const entry = { command: executablePath, args: ["mcp"] };
  const files = [
    [join(home, ".claude.json"), { sentinel: "claude", mcpServers: { "usable-git": entry } }],
    [join(home, ".cursor", "mcp.json"), { sentinel: "cursor", mcpServers: { "usable-git": entry } }],
    [join(home, ".config", "devin", "config.json"), { sentinel: "devin", mcpServers: { "usable-git": entry } }],
  ] as const;
  for (const [path, value] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value)}\n`);
  }
};

describe("runDoctor", () => {
  test("proves the real CLI, raw MCP, publish preservation, push, registrations, and fresh clients", async () =>
    withTempDirectory("usable-git-doctor-home-", async (home) => {
      const executablePath = await executableFixture(home);
      await writeMatchingConfigs(home, executablePath);
      const invoked: string[] = [];
      const clientInvoker: DoctorClientInvoker = async ({ client, repoPath }) => {
        invoked.push(client);
        expect(repoPath).toContain("usable-git-doctor-");
        return {
          available: true,
          invoked: true,
          operation: "inspect",
          transport: "mcp",
          diagnostic: "fresh session called mcp usable-git inspect",
        };
      };

      const report = await runDoctor({
        clients: "all",
        executablePath,
        home,
        runner: matchingInstallRunner(executablePath),
        clientInvoker,
      });

      expect(report.version).toBe("v1");
      expect(report.ok).toBe(true);
      expect(report.clients).toEqual(["codex", "claude", "cursor", "devin"]);
      expect(report.summary).toEqual({ passed: 14, failed: 0, skipped: 0 });
      expect(report.checks.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: "runtime.bun", status: "pass" },
        { id: "runtime.git", status: "pass" },
        { id: "cli.inspect", status: "pass" },
        { id: "mcp.protocol", status: "pass" },
        { id: "repository.publish-preservation", status: "pass" },
        { id: "repository.push-one-ref", status: "pass" },
        { id: "client.codex.registration", status: "pass" },
        { id: "client.codex.fresh-session", status: "pass" },
        { id: "client.claude.registration", status: "pass" },
        { id: "client.claude.fresh-session", status: "pass" },
        { id: "client.cursor.registration", status: "pass" },
        { id: "client.cursor.fresh-session", status: "pass" },
        { id: "client.devin.registration", status: "pass" },
        { id: "client.devin.fresh-session", status: "pass" },
      ]);
      expect(invoked).toEqual(["codex", "claude", "cursor", "devin"]);
      expect(report.checks.find(({ id }) => id === "mcp.protocol")?.details).toMatchObject({
        initialized: true,
        tools: ["inspect", "review", "history", "publish", "push"],
        called: "inspect",
      });
      expect(report.checks.find(({ id }) => id === "repository.publish-preservation")?.details)
        .toMatchObject({ fsck: true, committedPaths: ["selected.txt"], unrelatedStagedPreserved: true });
      expect(report.checks.find(({ id }) => id === "repository.push-one-ref")?.details)
        .toMatchObject({ fsck: true, refCount: 1, targetRef: "refs/heads/main" });
    }), 15_000);

  test("fails overall on a required check failure and skips only an unavailable selected client", async () =>
    withTempDirectory("usable-git-doctor-failure-", async (home) => {
      const executablePath = await executableFixture(home);
      await writeMatchingConfigs(home, executablePath);
      const baseProcessRunner = createDoctorProcessRunner();
      const processRunner: DoctorProcessRunner = async (request) =>
        request.command === "git" && request.args[0] === "--version"
          ? { exitCode: 127, stdout: "", stderr: "git unavailable" }
          : baseProcessRunner(request);
      const clientInvoker: DoctorClientInvoker = async () => ({
        available: false,
        invoked: false,
        reason: "client executable not found",
      });

      const report = await runDoctor({
        clients: ["codex"],
        executablePath,
        home,
        runner: matchingInstallRunner(executablePath),
        processRunner,
        clientInvoker,
      });

      expect(report.ok).toBe(false);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.skipped).toBe(1);
      expect(report.checks.find(({ id }) => id === "runtime.git")).toMatchObject({
        required: true,
        status: "fail",
      });
      expect(report.checks.find(({ id }) => id === "client.codex.fresh-session")).toMatchObject({
        required: true,
        status: "skip",
        reason: "client executable not found",
      });
      expect(report.activatedClients).toEqual([]);
    }), 15_000);

  test("treats an unavailable selected client as an incomplete doctor run", async () =>
    withTempDirectory("usable-git-doctor-skip-", async (home) => {
      const executablePath = await executableFixture(home);
      await writeMatchingConfigs(home, executablePath);

      const report = await runDoctor({
        clients: ["codex"],
        executablePath,
        home,
        runner: matchingInstallRunner(executablePath),
        clientInvoker: async () => ({
          available: false,
          invoked: false,
          reason: "client executable not found",
        }),
      });

      expect(report.ok).toBe(false);
      expect(report.summary).toEqual({ passed: 7, failed: 0, skipped: 1 });
      expect(report.activatedClients).toEqual([]);
    }), 15_000);

  test("removes the banned Anthropic API key from doctor subprocesses", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    try {
      const result = await createDoctorProcessRunner()({
        command: "printenv",
        args: ["ANTHROPIC_API_KEY"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });
});
