import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { streamCursorLog, stripQueryWrappers } from "../src/sources/cursor";
import * as fs from "fs";
import * as path from "path";

const tempDir = path.join(__dirname, "fixtures", "temp_cursor_test");
const logFilePath = path.join(tempDir, "cursor_session.jsonl");

beforeAll(() => {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Cursor log file fixture
  fs.writeFileSync(
    logFilePath,
    [
      // User message with wrappers
      `{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Friday, Jul 3, 2026, 3:36 PM (UTC+2)</timestamp>\\n<user_query>\\ngit status\\n</user_query>"}]}}`,
      // Assistant reasoning & message
      `{"role":"assistant","message":{"content":[{"type":"text","text":"I will run git status."}]}}`,
      // Assistant tool call (Shell)
      `{"role":"assistant","message":{"content":[{"type":"tool_use","name":"Shell","input":{"command":"git status"}}]}}`,
      // Turn ended status
      `{"type":"turn_ended","status":"success"}`
    ].join("\n") + "\n"
  );
});

afterAll(() => {
  if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
  if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
});

describe("Cursor Source Adapter", () => {
  test("stripQueryWrappers cleans up text", () => {
    const raw = "<timestamp>Jul 3</timestamp>\n<user_query>\nhello\n</user_query>";
    expect(stripQueryWrappers(raw)).toBe("hello");
  });

  test("streamCursorLog streams and groups events correctly", async () => {
    const events = [];
    for await (const event of streamCursorLog(logFilePath)) {
      events.push(event);
    }

    // Should yield 2 events: user, grouped assistant
    expect(events.length).toBe(2);

    // 1. User event
    expect(events[0].role).toBe("user");
    expect((events[0] as any).text).toBe("git status");
    expect((events[0] as any).ts).toBe(new Date("Friday, Jul 3, 2026, 3:36 PM (UTC+2)").toISOString());

    // 2. Grouped assistant event
    expect(events[1].role).toBe("assistant");
    const assistant = events[1] as any;
    expect(assistant.text).toEqual(["I will run git status."]);
    expect(assistant.tool_calls.length).toBe(1);
    expect(assistant.tool_calls[0].name).toBe("Bash");
    expect(assistant.tool_calls[0].input.command).toBe("git status");
    expect(assistant.tool_calls[0].id).toBe("cursor_tool_3_1");
  });
});
