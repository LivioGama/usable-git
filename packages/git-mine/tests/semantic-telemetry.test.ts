import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetrySink } from "../../usable-git/src/telemetry/event";
import {
  ingestSemanticTelemetry,
  migrateLegacyDatabase,
  openRedactedDatabase,
} from "../src/semantic/redacted-store";
import { initDb, saveSessionEpisodes, type DbEpisode, type DbStep } from "../src/store";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "git-mine-semantic-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const hashFile = async (path: string) =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const telemetryInput = {
  client: "codex" as const,
  transport: "mcp" as const,
  durationMs: 10,
  gitSubprocessCount: 1,
  counts: {
    selected: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    commits: 0,
    warnings: 0,
  },
  components: {
    usableGit: "0.1.0",
    bun: "1.3.14",
    git: "2.54.0",
    client: "0.114.0",
  },
  repositoryIdentity: "/sensitive/repository/name",
};

const writeSemanticFixture = async (directory: string) => {
  const stateRoot = join(directory, "telemetry-state");
  const sink = createTelemetrySink({ enabled: true, stateRoot });
  await sink.emit({ ...telemetryInput, operation: "inspect", resultCode: "success" });
  await sink.emit({
    ...telemetryInput,
    operation: "publish",
    resultCode: "HOOK_FAILED",
    durationMs: 30,
    gitSubprocessCount: 3,
  });
  return join(stateRoot, "usable-git", "telemetry-v1.jsonl");
};

describe("semantic telemetry ingestion", () => {
  test("ingests strict v1 events without adding content-bearing columns", async () => {
    const directory = await createTemporaryDirectory();
    const telemetryPath = await writeSemanticFixture(directory);
    const databasePath = join(directory, "redacted.db");
    const database = openRedactedDatabase(databasePath);

    const outcome = await ingestSemanticTelemetry(database, telemetryPath);
    const rows = database
      .query("SELECT operation, result_code, repository_hash FROM semantic_events ORDER BY rowid")
      .all() as Array<{ operation: string; result_code: string; repository_hash: string }>;
    const columns = database.query("PRAGMA table_info(semantic_events)").all() as Array<{ name: string }>;
    database.close();

    expect(outcome).toEqual({ inserted: 2 });
    expect(rows.map((row) => [row.operation, row.result_code])).toEqual([
      ["inspect", "success"],
      ["publish", "HOOK_FAILED"],
    ]);
    expect(rows[0]!.repository_hash).toMatch(/^[a-f0-9]{64}$/);
    const columnNames = columns.map((column) => column.name);
    for (const forbiddenColumn of [
      "repo_path",
      "file_name",
      "message",
      "prompt",
      "reasoning",
      "patch",
      "command",
      "argv",
      "stderr",
      "remote_url",
      "environment",
      "request_id",
    ]) {
      expect(columnNames).not.toContain(forbiddenColumn);
    }
    expect((await readFile(databasePath)).includes(Buffer.from("/sensitive/repository/name"))).toBe(false);
  });

  test("rejects a malformed line atomically without partial ingestion", async () => {
    const directory = await createTemporaryDirectory();
    const telemetryPath = await writeSemanticFixture(directory);
    const validLine = (await readFile(telemetryPath, "utf8")).trim().split("\n")[0]!;
    const invalidLine = JSON.stringify({ ...JSON.parse(validLine), repoPath: "/must/not/persist" });
    const inputPath = join(directory, "invalid.jsonl");
    await writeFile(inputPath, `${validLine}\n${invalidLine}\n`, "utf8");
    const database = openRedactedDatabase(join(directory, "redacted.db"));

    await expect(ingestSemanticTelemetry(database, inputPath)).rejects.toThrow("line 2");
    const count = database.query("SELECT count(*) AS count FROM semantic_events").get() as { count: number };
    database.close();

    expect(count.count).toBe(0);
  });
});

describe("legacy redacted migration", () => {
  test("creates a separate database with aggregates while preserving the original byte-for-byte", async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "legacy.db");
    const destinationPath = join(directory, "redacted.db");
    const source = initDb(sourcePath);
    const secret = "PRIVATE prompt /Users/alice/customer/file.ts token=top-secret";
    const episodes: DbEpisode[] = [
      {
        id: "ep-read",
        session_id: "session-private",
        intent: secret,
        intent_source: "human",
        reasoning: secret,
        llm_ops: 6,
        context_ops: 2,
        outcome: "read_only",
        shape: "status>status>diff",
        ts: "2026-07-14T10:00:00.000Z",
        tool: "claude",
      },
      {
        id: "ep-publish",
        session_id: "session-private",
        intent: secret,
        intent_source: "human",
        reasoning: secret,
        llm_ops: 4,
        context_ops: 1,
        outcome: "commit",
        shape: "add>commit",
        ts: "2026-07-14T11:00:00.000Z",
        tool: "codex",
      },
      {
        id: "ep-outside",
        session_id: "session-private",
        intent: secret,
        intent_source: "human",
        reasoning: secret,
        llm_ops: 2,
        context_ops: 0,
        outcome: "success",
        shape: "checkout",
        ts: "2026-07-14T12:00:00.000Z",
        tool: "cursor",
      },
    ];
    const steps: DbStep[] = [
      ...["status", "status", "diff"].map((command, index) => ({
        id: `ep-read-${index}`,
        episode_id: "ep-read",
        step_index: index,
        command: `git ${command} ${secret}`,
        raw_command: `git ${command} ${secret}`,
        output: `${secret} output`,
        exit_code: 0,
        is_error: 0,
        ts: `2026-07-14T10:00:0${index}.000Z`,
      })),
      ...["add", "commit"].map((command, index) => ({
        id: `ep-publish-${index}`,
        episode_id: "ep-publish",
        step_index: index,
        command: `git ${command} ${secret}`,
        raw_command: `git ${command} ${secret}`,
        output: `${secret} output`,
        exit_code: 0,
        is_error: 0,
        ts: `2026-07-14T11:00:0${index}.000Z`,
      })),
      {
        id: "ep-outside-0",
        episode_id: "ep-outside",
        step_index: 0,
        command: `git checkout ${secret}`,
        raw_command: `git checkout ${secret}`,
        output: `${secret} output`,
        exit_code: 0,
        is_error: 0,
        ts: "2026-07-14T12:00:00.000Z",
      },
    ];
    saveSessionEpisodes(source, `${secret}.jsonl`, 100, 200, "session-private", episodes, steps);
    source.close();
    const sourceHashBefore = await hashFile(sourcePath);

    const outcome = migrateLegacyDatabase({ sourcePath, destinationPath });
    const sourceHashAfter = await hashFile(sourcePath);
    const redactedBytes = await readFile(destinationPath);
    const redacted = new Database(destinationPath, { readonly: true });
    const rows = redacted
      .query(
        "SELECT client, applicable_operation, raw_git_operations, repeated_read_count, estimated_git_tokens FROM raw_fallbacks ORDER BY rowid",
      )
      .all();
    redacted.close();

    expect(outcome).toEqual({ migratedEpisodes: 3 });
    expect(sourceHashAfter).toBe(sourceHashBefore);
    expect(redactedBytes.includes(Buffer.from(secret))).toBe(false);
    expect(rows).toEqual([
      {
        client: "claude-code",
        applicable_operation: "review",
        raw_git_operations: 3,
        repeated_read_count: 1,
        estimated_git_tokens: Math.round((`${secret} output`.length * 3) / 4),
      },
      {
        client: "codex",
        applicable_operation: "publish",
        raw_git_operations: 2,
        repeated_read_count: 0,
        estimated_git_tokens: Math.round((`${secret} output`.length * 2) / 4),
      },
      {
        client: "cursor-agent",
        applicable_operation: null,
        raw_git_operations: 1,
        repeated_read_count: 0,
        estimated_git_tokens: Math.round(`${secret} output`.length / 4),
      },
    ]);

    expect(() => migrateLegacyDatabase({ sourcePath, destinationPath })).toThrow("already exists");
    expect(await hashFile(sourcePath)).toBe(sourceHashBefore);
  });
});
