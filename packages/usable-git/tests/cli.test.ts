import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseJsonRequest, runCli as runCliCommand } from "../src/cli.ts";
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
  test("maps explicit JSON flags to all five v1 request shapes", () => {
    const oid = "a".repeat(40);
    const fingerprint = "b".repeat(64);
    expect(parseJsonRequest("inspect", ["--json", "--repo-path", "/repo", "--file", "a.txt"]))
      .toEqual({ repoPath: "/repo", files: ["a.txt"] });
    expect(parseJsonRequest("review", ["--json", "--repo-path", "/repo", "--byte-cap", "2048"]))
      .toEqual({ repoPath: "/repo", byteCap: 2048 });
    expect(parseJsonRequest("history", ["--json", "--repo-path", "/repo", "--ref", "main", "--limit", "5"]))
      .toEqual({ repoPath: "/repo", ref: "main", limit: 5 });
    expect(parseJsonRequest("publish", [
      "--json", "--repo-path", "/repo", "--file", "a.txt", "--message", "ship",
      "--request-id", "request-1", "--expected-head", oid,
      "--expected-fingerprint", `a.txt=${fingerprint}`,
    ])).toEqual({
      repoPath: "/repo",
      files: ["a.txt"],
      message: "ship",
      requestId: "request-1",
      expectedHead: { kind: "oid", oid },
      expectedFingerprints: { "a.txt": fingerprint },
    });
    expect(parseJsonRequest("push", [
      "--json", "--repo-path", "/repo", "--remote", "origin",
      "--source-ref", "refs/heads/main", "--target-ref", "refs/heads/main",
      "--request-id", "request-2", "--expected-source-oid", oid,
      "--mode", "force-with-lease", "--expected-target-oid", oid,
    ])).toEqual({
      repoPath: "/repo",
      remote: "origin",
      sourceRef: "refs/heads/main",
      targetRef: "refs/heads/main",
      requestId: "request-2",
      expectedSourceOid: oid,
      mode: { kind: "force-with-lease", expectedTargetOid: oid },
    });
  });

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

  test("routes doctor --clients through end-to-end diagnostics", async () => {
    const output: string[] = [];
    const calls: unknown[] = [];
    const exitCode = await runCliCommand(["doctor", "--clients", "codex,cursor"], {
      executablePath: "/opt/homebrew/bin/usable-git",
      writeStdout: (value) => output.push(value),
      writeStderr: () => undefined,
      runDoctor: async (options) => {
        calls.push(options);
        return {
          version: "v1",
          ok: true,
          clients: ["codex", "cursor"],
          activatedClients: ["codex", "cursor"],
          executablePath: options.executablePath,
          checks: [],
          summary: { passed: 0, failed: 0, skipped: 0 },
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{
      clients: ["codex", "cursor"],
      executablePath: "/opt/homebrew/bin/usable-git",
    }]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      version: "v1",
      ok: true,
      activatedClients: ["codex", "cursor"],
    });
  });
});
