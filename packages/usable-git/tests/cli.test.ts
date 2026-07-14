import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCli as runCliCommand } from "../src/cli.ts";
import {
  commitFile,
  createRepository,
  type TestRepository,
  writeFile,
} from "./helpers/repository.ts";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const repositories: TestRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map(({ cleanup }) => cleanup())));

const runCli = async (args: string[], input?: unknown) => {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: join(import.meta.dir, ".."),
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("usable-git JSON CLI", () => {
  test("executes a real inspect request from stdin and emits one envelope", async () => {
    const repository = await createRepository();
    repositories.push(repository);
    await commitFile(repository, "tracked.txt", "base\n", "initial");
    await writeFile(repository, "tracked.txt", "changed\n");

    const outcome = await runCli(["inspect", "--input", "-"], {
      repoPath: repository.path,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");
    const lines = outcome.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      version: "v1",
      ok: true,
      operation: "inspect",
      transport: "cli",
      result: { unstaged: ["tracked.txt"] },
    });
  });

  test("returns a JSON error envelope and stable nonzero exit", async () => {
    const outcome = await runCli(["inspect", "--input", "-"], { repoPath: "relative" });
    expect(outcome.exitCode).toBe(2);
    expect(JSON.parse(outcome.stdout)).toMatchObject({
      ok: false,
      operation: "inspect",
      error: { code: "INVALID_INPUT" },
    });
  });

  test("rejects unknown commands without writing protocol JSON", async () => {
    const outcome = await runCli(["unknown"]);
    expect(outcome.exitCode).toBe(64);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("Usage:");
  });

  test("routes install --clients all through the safe client installer", async () => {
    const output: string[] = [];
    const calls: unknown[] = [];
    const exitCode = await runCliCommand(["install", "--clients", "all", "--force"], {
      executablePath: "/opt/homebrew/bin/usable-git",
      writeStdout: (value) => output.push(value),
      writeStderr: () => undefined,
      installClients: async (options) => {
        calls.push(options);
        return [{ client: "codex", status: "installed" }];
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([{
      clients: "all",
      executablePath: "/opt/homebrew/bin/usable-git",
      force: true,
    }]);
    expect(JSON.parse(output.join(""))).toEqual({
      ok: true,
      command: "install",
      results: [{ client: "codex", status: "installed" }],
    });
  });
});
