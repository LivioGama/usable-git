import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  telemetryEventSchema,
  type TelemetryEvent,
} from "../../../usable-git/src/telemetry/event";

type SemanticOperation = "inspect" | "review" | "history" | "publish" | "push";

interface LegacyAggregateRow {
  shape: string;
  outcome: string;
  llm_ops: number;
  context_ops: number;
  tool: string;
  raw_git_operations: number;
  output_chars: number;
  first_ts: string | null;
  last_ts: string | null;
}

const READ_OPERATIONS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "branch",
  "remote",
  "cat-file",
  "config",
]);

const parseSafeShape = (shape: string) => {
  const operations = shape.split(">").filter(Boolean);
  return operations.length > 0 && operations.every((operation) => /^[a-z0-9][a-z0-9-]*$/.test(operation))
    ? operations
    : [];
};

const classifyApplicableOperation = (operations: string[]): SemanticOperation | null => {
  if (operations.includes("push")) return "push";
  if (operations.includes("add") && operations.includes("commit")) return "publish";
  if (operations.some((operation) => operation === "diff" || operation === "show")) return "review";
  if (operations.includes("log")) return "history";
  if (operations.length > 0 && operations.every((operation) => READ_OPERATIONS.has(operation))) {
    return "inspect";
  }
  return null;
};

const countRepeatedReads = (operations: string[]) => {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    if (READ_OPERATIONS.has(operation)) {
      counts.set(operation, (counts.get(operation) ?? 0) + 1);
    }
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
};

const sanitizeClient = (tool: string) => {
  switch (tool.toLowerCase()) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    case "cursor":
    case "cursor-agent":
      return "cursor-agent";
    case "devin":
    case "devin-cli":
      return "devin-cli";
    default:
      return "other";
  }
};

const sanitizeOutcome = (outcome: string) =>
  outcome === "failure" || outcome.startsWith("failed_") ? "failure" : "success";

const durationBetween = (first: string | null, last: string | null) => {
  if (!first || !last) return null;
  const firstMs = Date.parse(first);
  const lastMs = Date.parse(last);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs < firstMs) return null;
  return lastMs - firstMs;
};

const initializeSchema = (database: Database) => {
  database.run("PRAGMA foreign_keys = ON");
  database.run(`
    CREATE TABLE IF NOT EXISTS semantic_events (
      version TEXT NOT NULL,
      operation TEXT NOT NULL,
      client TEXT NOT NULL,
      transport TEXT NOT NULL,
      backend TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      git_subprocess_count INTEGER NOT NULL,
      result_code TEXT NOT NULL,
      selected_count INTEGER NOT NULL,
      staged_count INTEGER NOT NULL,
      unstaged_count INTEGER NOT NULL,
      untracked_count INTEGER NOT NULL,
      conflicted_count INTEGER NOT NULL,
      commit_count INTEGER NOT NULL,
      warning_count INTEGER NOT NULL,
      usable_git_version TEXT NOT NULL,
      bun_version TEXT NOT NULL,
      git_version TEXT NOT NULL,
      client_version TEXT NOT NULL,
      repository_hash TEXT NOT NULL
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS raw_fallbacks (
      client TEXT NOT NULL,
      applicable_operation TEXT,
      result_code TEXT NOT NULL,
      raw_git_operations INTEGER NOT NULL,
      repeated_read_count INTEGER NOT NULL,
      llm_operations INTEGER NOT NULL,
      context_operations INTEGER NOT NULL,
      estimated_git_tokens INTEGER NOT NULL,
      duration_ms REAL
    )
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS migration_summary (
      migrated_episodes INTEGER NOT NULL
    )
  `);
};

export const openRedactedDatabase = (databasePath: string) => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath, { create: true });
  initializeSchema(database);
  return database;
};

const insertSemanticEvent = (
  statement: ReturnType<Database["prepare"]>,
  event: TelemetryEvent,
) =>
  statement.run(
    event.version,
    event.operation,
    event.client,
    event.transport,
    event.backend,
    event.durationMs,
    event.gitSubprocessCount,
    event.resultCode,
    event.counts.selected,
    event.counts.staged,
    event.counts.unstaged,
    event.counts.untracked,
    event.counts.conflicted,
    event.counts.commits,
    event.counts.warnings,
    event.components.usableGit,
    event.components.bun,
    event.components.git,
    event.components.client,
    event.repositoryHash,
  );

export const ingestSemanticTelemetry = async (database: Database, telemetryPath: string) => {
  const lines = (await readFile(telemetryPath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const events = lines.map((line, index) => {
    try {
      return telemetryEventSchema.parse(JSON.parse(line));
    } catch {
      throw new Error(`Invalid semantic telemetry at line ${index + 1}`);
    }
  });
  const statement = database.prepare(`
    INSERT INTO semantic_events
      (version, operation, client, transport, backend, duration_ms, git_subprocess_count,
       result_code, selected_count, staged_count, unstaged_count, untracked_count,
       conflicted_count, commit_count, warning_count, usable_git_version, bun_version,
       git_version, client_version, repository_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = database.transaction(() => {
    for (const event of events) insertSemanticEvent(statement, event);
  });
  insertAll();
  return { inserted: events.length };
};

export interface LegacyMigrationOptions {
  sourcePath: string;
  destinationPath: string;
}

export const migrateLegacyDatabase = ({ sourcePath, destinationPath }: LegacyMigrationOptions) => {
  if (resolve(sourcePath) === resolve(destinationPath)) {
    throw new Error("Legacy source and redacted destination must be different files");
  }
  if (existsSync(destinationPath)) {
    throw new Error(`Redacted destination already exists: ${destinationPath}`);
  }

  const source = new Database(sourcePath, { readonly: true });
  let destination: Database | undefined;
  try {
    const rows = source
      .query(`
        SELECT
          e.shape,
          e.outcome,
          e.llm_ops,
          e.context_ops,
          e.tool,
          count(s.id) AS raw_git_operations,
          coalesce(sum(length(coalesce(s.output, ''))), 0) AS output_chars,
          min(s.ts) AS first_ts,
          max(s.ts) AS last_ts
        FROM episodes e
        LEFT JOIN steps s ON s.episode_id = e.id
        GROUP BY e.id
        ORDER BY e.rowid
      `)
      .all() as LegacyAggregateRow[];
    destination = openRedactedDatabase(destinationPath);
    const insert = destination.prepare(`
      INSERT INTO raw_fallbacks
        (client, applicable_operation, result_code, raw_git_operations, repeated_read_count,
         llm_operations, context_operations, estimated_git_tokens, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const migrate = destination.transaction(() => {
      for (const row of rows) {
        const operations = parseSafeShape(row.shape);
        insert.run(
          sanitizeClient(row.tool),
          classifyApplicableOperation(operations),
          sanitizeOutcome(row.outcome),
          row.raw_git_operations,
          countRepeatedReads(operations),
          row.llm_ops,
          row.context_ops,
          Math.round(row.output_chars / 4),
          durationBetween(row.first_ts, row.last_ts),
        );
      }
      destination!.prepare("INSERT INTO migration_summary (migrated_episodes) VALUES (?)").run(rows.length);
    });
    migrate();
    destination.close();
    destination = undefined;
    return { migratedEpisodes: rows.length };
  } catch (error) {
    destination?.close();
    rmSync(destinationPath, { force: true });
    throw error;
  } finally {
    source.close();
  }
};
