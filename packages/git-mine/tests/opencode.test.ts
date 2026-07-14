import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { findOpenCodeSessions, streamOpenCodeLog, skippedOpenCodeToolsCount } from "../src/sources/opencode";
import * as fs from "fs";
import * as path from "path";

const tempDir = path.join(__dirname, "fixtures", "temp_opencode_test");
const dbPath = path.join(tempDir, "opencode.db");

beforeAll(() => {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  const db = new Database(dbPath);

  // Create tables
  db.run(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )
  `);

  // Insert mock session
  db.run(`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('opencode-sess-1', 'proj-1', 'opencode-slug', '/Users/livio/opencode-workspace', 'Mock Session', '1.0', 1782000000, 1782005000)
  `);

  // Message 1: User
  db.run(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES ('msg-1', 'opencode-sess-1', 1782001000, 1782001000, '{"role":"user"}')
  `);
  db.run(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('part-1', 'msg-1', 'opencode-sess-1', 1782001100, 1782001100, '{"type":"text","text":"Check status"}')
  `);

  // Message 2: Assistant
  db.run(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES ('msg-2', 'opencode-sess-1', 1782002000, 1782002000, '{"role":"assistant"}')
  `);
  db.run(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('part-2-reason', 'msg-2', 'opencode-sess-1', 1782002100, 1782002100, '{"type":"reasoning","text":"I will run git status"}')
  `);
  db.run(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('part-2-text', 'msg-2', 'opencode-sess-1', 1782002200, 1782002200, '{"type":"text","text":"Running status command now."}')
  `);

  const toolPart = JSON.stringify({
    type: "tool",
    tool: "bash",
    callID: "call-opencode-999",
    state: {
      status: "completed",
      input: { command: "git status", description: "git status" },
      output: "On branch main\nnothing to commit"
    },
    metadata: {
      exit: 0
    }
  });
  db.run(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('part-2-tool', 'msg-2', 'opencode-sess-1', 1782002300, 1782002300, ?)
  `, [toolPart]);

  // Non-bash tool part (should be skipped and increment counter)
  const nonBashToolPart = JSON.stringify({
    type: "tool",
    tool: "read",
    callID: "call-read-888"
  });
  db.run(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('part-2-tool-nonbash', 'msg-2', 'opencode-sess-1', 1782002400, 1782002400, ?)
  `, [nonBashToolPart]);

  db.close();
});

afterAll(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
});

describe("OpenCode Source Adapter", () => {
  test("findOpenCodeSessions finds sessions", () => {
    const sessions = findOpenCodeSessions(null, dbPath);
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("opencode-sess-1");
    expect(sessions[0].workingDirectory).toBe("/Users/livio/opencode-workspace");
    expect(sessions[0].mtimeMs).toBe(1782005000);
  });

  test("streamOpenCodeLog streams messages and parts correctly", async () => {
    const prevCount = skippedOpenCodeToolsCount;
    const events = [];
    for await (const ev of streamOpenCodeLog("opencode-sess-1", dbPath)) {
      events.push(ev);
    }

    // Should yield 3 events: user, assistant, tool
    expect(events.length).toBe(3);

    // 1. User event
    expect(events[0].role).toBe("user");
    expect((events[0] as any).text).toBe("Check status");

    // 2. Assistant event
    expect(events[1].role).toBe("assistant");
    const assistant = events[1] as any;
    expect(assistant.thinking).toEqual(["I will run git status"]);
    expect(assistant.text).toEqual(["Running status command now."]);
    expect(assistant.tool_calls.length).toBe(1);
    expect(assistant.tool_calls[0].name).toBe("Bash");
    expect(assistant.tool_calls[0].input.command).toBe("git status");
    expect(assistant.tool_calls[0].id).toBe("call-opencode-999");

    // 3. Tool event
    expect(events[2].role).toBe("tool");
    const tool = events[2] as any;
    expect(tool.tool_results.length).toBe(1);
    expect(tool.tool_results[0].tool_use_id).toBe("call-opencode-999");
    expect(tool.tool_results[0].content).toBe("On branch main\nnothing to commit");
    expect(tool.tool_results[0].is_error).toBe(false);

    // Skipped tool count check
    expect(skippedOpenCodeToolsCount).toBe(prevCount + 1);
  });
});
