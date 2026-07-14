import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, saveSessionEpisodes } from "../src/store";

const temporaryDirectories: string[] = [];
const cliPath = join(import.meta.dir, "..", "bin", "git-mine.ts");

const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "git-mine-semantic-cli-"));
  temporaryDirectories.push(directory);
  return directory;
};

const runCli = async (...args: string[]) => {
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const hashFile = async (path: string) =>
  createHash("sha256").update(await readFile(path)).digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("git-mine semantic CLI", () => {
  test("migrates a legacy database only to an explicit new destination", async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "legacy.db");
    const destinationPath = join(directory, "redacted.db");
    const source = initDb(sourcePath);
    saveSessionEpisodes(
      source,
      "/private/session.jsonl",
      10,
      20,
      "session-private",
      [{
        id: "episode-1",
        session_id: "session-private",
        intent: "private prompt",
        intent_source: "human",
        reasoning: "private reasoning",
        llm_ops: 3,
        context_ops: 1,
        outcome: "success",
        shape: "status>diff",
        ts: "2026-07-14T10:00:00.000Z",
        tool: "codex",
      }],
      [{
        id: "step-1",
        episode_id: "episode-1",
        step_index: 0,
        command: "git status",
        raw_command: "git status",
        output: "private output",
        exit_code: 0,
        is_error: 0,
        ts: "2026-07-14T10:00:01.000Z",
      }],
    );
    source.close();
    const sourceHash = await hashFile(sourcePath);

    const missingDestination = await runCli("semantic-migrate", "--source", sourcePath);
    expect(missingDestination.exitCode).toBe(1);
    expect(missingDestination.stderr).toContain("--destination");

    const migrated = await runCli(
      "semantic-migrate",
      "--source",
      sourcePath,
      "--destination",
      destinationPath,
    );
    expect(migrated.exitCode).toBe(0);
    expect(JSON.parse(migrated.stdout)).toEqual({ migratedEpisodes: 1 });
    expect(await hashFile(sourcePath)).toBe(sourceHash);
    expect((await readFile(destinationPath)).includes(Buffer.from("private prompt"))).toBe(false);

    const overwrite = await runCli(
      "semantic-migrate",
      "--source",
      sourcePath,
      "--destination",
      destinationPath,
    );
    expect(overwrite.exitCode).toBe(1);
    expect(overwrite.stderr).toContain("already exists");
    expect(await hashFile(sourcePath)).toBe(sourceHash);
  });

  test("ingests semantic JSONL and emits the adoption report as JSON", async () => {
    const directory = await createTemporaryDirectory();
    const telemetryPath = join(directory, "telemetry.jsonl");
    const databasePath = join(directory, "redacted.db");
    const unintendedDatabasePath = join(directory, "missing-input.db");
    const missingInput = await runCli(
      "semantic-ingest",
      "--database",
      unintendedDatabasePath,
    );
    expect(missingInput.exitCode).toBe(1);
    expect(missingInput.stderr).toContain("--input");
    expect(existsSync(unintendedDatabasePath)).toBe(false);

    await writeFile(
      telemetryPath,
      `${JSON.stringify({
        version: "v1",
        operation: "inspect",
        client: "codex",
        transport: "cli",
        backend: "git-cli",
        durationMs: 8,
        gitSubprocessCount: 1,
        resultCode: "success",
        counts: {
          selected: 0,
          staged: 0,
          unstaged: 1,
          untracked: 0,
          conflicted: 0,
          commits: 0,
          warnings: 0,
        },
        components: {
          usableGit: "0.1.0",
          bun: "1.3.14",
          git: "2.54.0",
          client: "0.1.0",
        },
        repositoryHash: "a".repeat(64),
      })}\n`,
      "utf8",
    );

    const ingested = await runCli(
      "semantic-ingest",
      "--input",
      telemetryPath,
      "--database",
      databasePath,
    );
    expect(ingested.exitCode).toBe(0);
    expect(JSON.parse(ingested.stdout)).toEqual({ inserted: 1 });

    const reported = await runCli("semantic-report", "--database", databasePath);
    expect(reported.exitCode).toBe(0);
    const report = JSON.parse(reported.stdout);
    expect(report.adoption).toEqual({
      semanticInvocations: 1,
      applicableRawFallbacks: 0,
      nonApplicableRawOperations: 0,
      semanticAdoptionRate: 1,
    });
    expect(report.outcomes).toEqual({ success: 1 });
    expect(report.distributions).toMatchObject({
      clients: { codex: 1 },
      transports: { cli: 1 },
      backends: { "git-cli": 1 },
    });
  });
});
