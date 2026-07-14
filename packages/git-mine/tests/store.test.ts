import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { initDb, getFileIngestState, saveSessionEpisodes, getAllEpisodes, getEpisodeById, getStepsForEpisode, DbEpisode, DbStep } from "../src/store";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

const TEST_DB = path.join(import.meta.dirname, "test-mine.db");

describe("store module", () => {
  let db: Database;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
    db = initDb(TEST_DB);
  });

  afterAll(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
  });

  test("initializes tables successfully", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain("ingest_state");
    expect(names).toContain("episodes");
    expect(names).toContain("steps");
  });

  test("saves and loads session episodes and steps", () => {
    const file = "test_session.jsonl";
    const fileSize = 1024;
    const mtimeMs = 123456789;
    const sessionId = "session_abc";

    const eps: DbEpisode[] = [
      {
        id: "ep_1",
        session_id: sessionId,
        intent: "do a commit",
        intent_source: "human",
        reasoning: "none",
        llm_ops: 4,
        context_ops: 2,
        outcome: "commit",
        shape: "add>commit",
        ts: "2026-07-06T00:00:00.000Z",
        tool: "claude"
      }
    ];

    const steps: DbStep[] = [
      {
        id: "ep_1_0",
        episode_id: "ep_1",
        step_index: 0,
        command: "git add .",
        raw_command: "git add .",
        output: "ok",
        exit_code: 0,
        is_error: 0,
        ts: "2026-07-06T00:00:01.000Z"
      },
      {
        id: "ep_1_1",
        episode_id: "ep_1",
        step_index: 1,
        command: "git commit",
        raw_command: "git commit",
        output: "committed",
        exit_code: 0,
        is_error: 0,
        ts: "2026-07-06T00:00:02.000Z"
      }
    ];

    saveSessionEpisodes(db, file, fileSize, mtimeMs, sessionId, eps, steps);

    // Verify ingest state
    const state = getFileIngestState(db, file);
    expect(state).not.toBeNull();
    expect(state!.file_size).toBe(fileSize);
    expect(state!.mtime_ms).toBe(mtimeMs);

    // Verify episodes
    const loadedEps = getAllEpisodes(db);
    expect(loadedEps.length).toBe(1);
    expect(loadedEps[0]!.id).toBe("ep_1");
    expect(loadedEps[0]!.intent).toBe("do a commit");
    expect(loadedEps[0]!.intent_source).toBe("human");
    expect(loadedEps[0]!.context_ops).toBe(2);
    expect(loadedEps[0]!.tool).toBe("claude");

    // Verify steps
    const loadedSteps = getStepsForEpisode(db, "ep_1");
    expect(loadedSteps.length).toBe(2);
    expect(loadedSteps[0]!.command).toBe("git add .");
    expect(loadedSteps[1]!.command).toBe("git commit");
  });

  test("cascade delete removes steps when episode is deleted", () => {
    // Session exists from previous test. Let's delete session_abc
    db.prepare("DELETE FROM episodes WHERE session_id = 'session_abc'").run();

    // Verify steps are gone
    const loadedSteps = getStepsForEpisode(db, "ep_1");
    expect(loadedSteps.length).toBe(0);

    const allEps = getAllEpisodes(db);
    expect(allEps.length).toBe(0);
  });
});
