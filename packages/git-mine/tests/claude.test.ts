import { describe, expect, test } from "bun:test";
import { streamClaudeLog } from "../src/sources/claude";
import * as path from "path";

const MOCK_LOG = path.join(import.meta.dirname, "fixtures", "mock_claude.jsonl");

describe("streamClaudeLog", () => {
  test("streams and parses log lines correctly", async () => {
    const events = [];
    for await (const ev of streamClaudeLog(MOCK_LOG)) {
      events.push(ev);
    }

    // Should have 3 events: user, assistant, tool
    // The mode and system lines should be ignored
    expect(events.length).toBe(3);

    // Event 1: User prompt
    expect(events[0]!.role).toBe("user");
    expect((events[0] as any).text).toBe("Do a status check please");

    // Event 2: Assistant turn
    expect(events[1]!.role).toBe("assistant");
    expect((events[1] as any).thinking).toEqual(["Checking status"]);
    expect((events[1] as any).tool_calls.length).toBe(1);
    expect((events[1] as any).tool_calls[0]!.name).toBe("Bash");
    expect((events[1] as any).tool_calls[0]!.input.command).toBe("git status");

    // Event 3: Tool result
    expect(events[2]!.role).toBe("tool");
    expect((events[2] as any).tool_results.length).toBe(1);
    expect((events[2] as any).tool_results[0]!.tool_use_id).toBe("toolu_status");
    expect((events[2] as any).tool_results[0]!.content).toBe("On branch main\nNothing to commit");
    expect((events[2] as any).tool_results[0]!.is_error).toBe(false);
  });
});
