import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { getCodexFileMeta, streamCodexLog, skippedCustomToolsCount } from "../src/sources/codex";
import * as fs from "fs";
import * as path from "path";

const tempDir = path.join(__dirname, "fixtures", "temp_codex_test");
const metaFilePath = path.join(tempDir, "meta_session.jsonl");
const logFilePath = path.join(tempDir, "log_session.jsonl");

beforeAll(() => {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Meta file fixture
  fs.writeFileSync(
    metaFilePath,
    `{"timestamp":"2026-04-27T19:18:56.360Z","type":"session_meta","payload":{"id":"mock-session-12345","cwd":"/Users/livio/mock-cwd"}}\n`
  );

  // General log file fixture
  fs.writeFileSync(
    logFilePath,
    [
      // session meta
      `{"timestamp":"2026-04-27T19:18:56.360Z","type":"session_meta","payload":{"id":"mock-session-12345","cwd":"/Users/livio/mock-cwd"}}`,
      // user event
      `{"timestamp":"2026-04-27T19:19:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Show git status"}]}}`,
      // assistant reasoning
      `{"timestamp":"2026-04-27T19:19:01.000Z","type":"response_item","payload":{"type":"reasoning","content":"I need to check git status.","summary":[]}}`,
      // assistant message
      `{"timestamp":"2026-04-27T19:19:02.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checking repository status now."}]}}`,
      // assistant tool call
      `{"timestamp":"2026-04-27T19:19:03.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"git status\\",\\"workdir\\":\\"/Users/livio/mock-cwd\\"}\u0000","call_id":"call-1"}}`,
      // tool output
      `{"timestamp":"2026-04-27T19:19:04.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"Chunk ID: 123\\nWall time: 0.1s\\nProcess exited with code 0\\nOutput:\\n---\\nOn branch main\\nnothing to commit, working tree clean"}}`,
      // developer message (should be dropped)
      `{"timestamp":"2026-04-27T19:19:05.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>"}]}}`,
      // custom tool call (should increment counter and be skipped)
      `{"timestamp":"2026-04-27T19:19:06.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":""}}`
    ].join("\n") + "\n"
  );
});

afterAll(() => {
  if (fs.existsSync(metaFilePath)) fs.unlinkSync(metaFilePath);
  if (fs.existsSync(logFilePath)) fs.unlinkSync(logFilePath);
  if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
});

describe("Codex Source Adapter", () => {
  test("getCodexFileMeta correctly extracts session ID and CWD", async () => {
    const meta = await getCodexFileMeta(metaFilePath);
    expect(meta).not.toBeNull();
    expect(meta!.sessionId).toBe("mock-session-12345");
    expect(meta!.cwd).toBe("/Users/livio/mock-cwd");
  });

  test("streamCodexLog streams and groups events correctly", async () => {
    const events = [];
    const prevCount = skippedCustomToolsCount;
    for await (const event of streamCodexLog(logFilePath)) {
      events.push(event);
    }

    // Should yield 3 events: user, assistant, tool (the developer message is dropped, custom tool is skipped)
    expect(events.length).toBe(3);

    // 1. User event
    expect(events[0].role).toBe("user");
    expect((events[0] as any).text).toBe("Show git status");

    // 2. Grouped Assistant event
    expect(events[1].role).toBe("assistant");
    const assistant = events[1] as any;
    expect(assistant.thinking).toEqual(["I need to check git status."]);
    expect(assistant.text).toEqual(["Checking repository status now."]);
    expect(assistant.tool_calls.length).toBe(1);
    expect(assistant.tool_calls[0].name).toBe("Bash");
    expect(assistant.tool_calls[0].input.command).toBe("git status");
    expect(assistant.tool_calls[0].id).toBe("call-1");

    // 3. Tool output event
    expect(events[2].role).toBe("tool");
    const tool = events[2] as any;
    expect(tool.tool_results.length).toBe(1);
    expect(tool.tool_results[0].tool_use_id).toBe("call-1");
    expect(tool.tool_results[0].content).toBe("On branch main\nnothing to commit, working tree clean");
    expect(tool.tool_results[0].is_error).toBe(false);

    // Custom tool skipped check
    expect(skippedCustomToolsCount).toBe(prevCount + 1);
  });
});
