import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface DbEpisode {
  id: string;
  session_id: string;
  intent: string;
  intent_source: string;
  reasoning: string;
  llm_ops: number;
  context_ops: number;
  outcome: string;
  shape: string;
  ts: string;
  tool: string;
}

export interface DbStep {
  id: string;
  episode_id: string;
  step_index: number;
  command: string;
  raw_command: string;
  output: string | null;
  exit_code: number | null;
  is_error: number;
  ts: string;
}

export interface IngestState {
  file_path: string;
  file_size: number;
  mtime_ms: number;
  ingested_at: string;
}

export function getDbPath(): string {
  return path.join(os.homedir(), ".local/share/git-mine/mine.db");
}

export function initDb(dbPath: string): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON;");

  db.run(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      file_path TEXT PRIMARY KEY,
      file_size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      ingested_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      intent_source TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      llm_ops INTEGER NOT NULL,
      context_ops INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      shape TEXT NOT NULL,
      ts TEXT NOT NULL,
      tool TEXT NOT NULL DEFAULT 'claude'
    )
  `);

  try {
    db.run("ALTER TABLE episodes ADD COLUMN tool TEXT NOT NULL DEFAULT 'claude'");
  } catch (e) {
    // Column already exists, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      command TEXT NOT NULL,
      raw_command TEXT NOT NULL,
      output TEXT,
      exit_code INTEGER,
      is_error INTEGER NOT NULL,
      ts TEXT NOT NULL
    )
  `);

  return db;
}

export function getFileIngestState(db: Database, filePath: string): IngestState | null {
  const stmt = db.prepare("SELECT * FROM ingest_state WHERE file_path = ?");
  const result = stmt.get(filePath);
  return result ? (result as IngestState) : null;
}

export function deleteSessionData(db: Database, sessionId: string) {
  const stmt = db.prepare("DELETE FROM episodes WHERE session_id = ?");
  stmt.run(sessionId);
}

export function saveSessionEpisodes(
  db: Database,
  filePath: string,
  fileSize: number,
  mtimeMs: number,
  sessionId: string,
  episodes: DbEpisode[],
  steps: DbStep[]
) {
  const insertEpisode = db.prepare(`
    INSERT INTO episodes (id, session_id, intent, intent_source, reasoning, llm_ops, context_ops, outcome, shape, ts, tool)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertStep = db.prepare(`
    INSERT INTO steps (id, episode_id, step_index, command, raw_command, output, exit_code, is_error, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIngest = db.prepare(`
    INSERT OR REPLACE INTO ingest_state (file_path, file_size, mtime_ms, ingested_at)
    VALUES (?, ?, ?, ?)
  `);

  const runTx = db.transaction(() => {
    // Delete existing session episodes (cascading deletes steps)
    deleteSessionData(db, sessionId);

    // Save new episodes
    for (const ep of episodes) {
      insertEpisode.run(
        ep.id,
        ep.session_id,
        ep.intent,
        ep.intent_source,
        ep.reasoning,
        ep.llm_ops,
        ep.context_ops,
        ep.outcome,
        ep.shape,
        ep.ts,
        ep.tool || "claude"
      );
    }

    // Save steps
    for (const step of steps) {
      insertStep.run(
        step.id,
        step.episode_id,
        step.step_index,
        step.command,
        step.raw_command,
        step.output,
        step.exit_code,
        step.is_error,
        step.ts
      );
    }

    // Update ingest state
    insertIngest.run(filePath, fileSize, mtimeMs, new Date().toISOString());
  });

  runTx();
}

export function getAllEpisodes(db: Database): DbEpisode[] {
  const stmt = db.prepare("SELECT * FROM episodes ORDER BY ts DESC");
  return stmt.all() as DbEpisode[];
}

export function getEpisodeById(db: Database, id: string): DbEpisode | null {
  const stmt = db.prepare("SELECT * FROM episodes WHERE id = ?");
  return (stmt.get(id) as DbEpisode) || null;
}

export function getStepsForEpisode(db: Database, episodeId: string): DbStep[] {
  const stmt = db.prepare("SELECT * FROM steps WHERE episode_id = ? ORDER BY step_index ASC");
  return stmt.all(episodeId) as DbStep[];
}
