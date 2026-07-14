import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { findDevinSessions, streamDevinLog } from "../src/sources/devin";
import * as fs from "fs";
import * as path from "path";

const tempDir = path.join(__dirname, "fixtures", "temp_devin_test");
const dbPath = path.join(tempDir, "sessions.db");

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
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      model TEXT NOT NULL,
      agent_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      title TEXT,
      main_chain_id INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Insert mock session
  db.run(`
    INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, main_chain_id, hidden)
    VALUES ('devin-session-abc', '/Users/livio/devin-workspace', 'local', 'gpt-4', 'yolo', 1782000000, 1782005000, 3, 0)
  `);

  // Insert mock message nodes (reconstructed from leaf node 3 up to parent node 2 up to parent node 1)
  // Node 1: User query
  const msgUser = JSON.stringify({
    role: "user",
    content: "Run status check"
  });
  db.run(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES ('devin-session-abc', 1, NULL, ?, 1782001000)
  `, [msgUser]);

  // Node 2: Assistant tool call
  const msgAssistant = JSON.stringify({
    role: "assistant",
    content: "Checking status...",
    thinking: { thinking: "Need to run git status" },
    tool_calls: [{
      id: "call-status-123",
      name: "exec_command",
      arguments: { cmd: "git status", workdir: "/Users/livio/devin-workspace" }
    }]
  });
  db.run(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES ('devin-session-abc', 2, 1, ?, 1782002000)
  `, [msgAssistant]);

  // Node 3: Tool response
  const msgTool = JSON.stringify({
    role: "tool",
    content: "On branch main\nnothing to commit",
    tool_call_id: "call-status-123",
    metadata: {
      extensions: {
        "chisel/tool_result_meta": { success: true }
      }
    }
  });
  db.run(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES ('devin-session-abc', 3, 2, ?, 1782003000)
  `, [msgTool]);

  // Insert second mock session for 'exec' command shape
  db.run(`
    INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, main_chain_id, hidden)
    VALUES ('devin-session-exec', '/Users/livio/devin-workspace', 'local', 'gpt-4', 'yolo', 1782000000, 1782005000, 6, 0)
  `);

  // Node 4: User query
  db.run(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES ('devin-session-exec', 4, NULL, '{"role":"user","content":"Run status check"}', 1782001000)
  `);

  // Node 5: Assistant tool call with name "exec"
  const execAssistant = JSON.stringify({
    role: "assistant",
    content: "Checking diff...",
    thinking: { thinking: "Need to run git diff" },
    tool_calls: [{
      id: "5c9aed286",
      name: "exec",
      arguments: { command: "git diff" },
      index: 0,
      kind: "function"
    }]
  });
  db.run(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES ('devin-session-exec', 5, 4, ?, 1782002000)
  `, [execAssistant]);

  // Node 6: Tool response
  const execTool = JSON.stringify({
    role: "tool",
    content: "diff content",
    tool_call_id: "5c9aed286",
    metadata: {
      extensions: {
        "chisel/tool_result_meta": { success: true }
      }
    }
  });
  db.run(`
    INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at)
    VALUES ('devin-session-exec', 6, 5, ?, 1782003000)
  `, [execTool]);

  db.close();
});

afterAll(() => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
});

describe("Devin Source Adapter", () => {
  test("findDevinSessions finds session", () => {
    const sessions = findDevinSessions(null, dbPath);
    expect(sessions.length >= 1).toBe(true);
    expect(sessions.some(s => s.sessionId === "devin-session-abc")).toBe(true);
    expect(sessions.some(s => s.sessionId === "devin-session-exec")).toBe(true);
  });

  test("streamDevinLog streams messages in chain correctly", async () => {
    const events = [];
    for await (const ev of streamDevinLog("devin-session-abc", dbPath)) {
      events.push(ev);
    }

    // Should have 3 events: user, assistant, tool
    expect(events.length).toBe(3);

    // 1. User event
    expect(events[0].role).toBe("user");
    expect((events[0] as any).text).toBe("Run status check");

    // 2. Assistant event
    expect(events[1].role).toBe("assistant");
    const assistant = events[1] as any;
    expect(assistant.thinking).toEqual(["Need to run git status"]);
    expect(assistant.text).toEqual(["Checking status..."]);
    expect(assistant.tool_calls.length).toBe(1);
    expect(assistant.tool_calls[0].name).toBe("Bash");
    expect(assistant.tool_calls[0].input.command).toBe("git status");
    expect(assistant.tool_calls[0].id).toBe("call-status-123");

    // 3. Tool event
    expect(events[2].role).toBe("tool");
    const tool = events[2] as any;
    expect(tool.tool_results.length).toBe(1);
    expect(tool.tool_results[0].tool_use_id).toBe("call-status-123");
    expect(tool.tool_results[0].content).toBe("On branch main\nnothing to commit");
    expect(tool.tool_results[0].is_error).toBe(false);
  });

  test("streamDevinLog handles 'exec' command with direct arguments object", async () => {
    const events = [];
    for await (const ev of streamDevinLog("devin-session-exec", dbPath)) {
      events.push(ev);
    }

    expect(events.length).toBe(3);

    expect(events[1].role).toBe("assistant");
    const assistant = events[1] as any;
    expect(assistant.tool_calls.length).toBe(1);
    expect(assistant.tool_calls[0].name).toBe("Bash");
    expect(assistant.tool_calls[0].input.command).toBe("git diff");
    expect(assistant.tool_calls[0].id).toBe("5c9aed286");

    expect(events[2].role).toBe("tool");
    const tool = events[2] as any;
    expect(tool.tool_results.length).toBe(1);
    expect(tool.tool_results[0].tool_use_id).toBe("5c9aed286");
    expect(tool.tool_results[0].content).toBe("diff content");
    expect(tool.tool_results[0].is_error).toBe(false);
  });
});
