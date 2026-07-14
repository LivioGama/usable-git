import { describe, expect, test } from "bun:test";
import { parseEpisodes, determineOutcome, isOrchestratorIntent } from "../src/episodes";
import { UnifiedEvent } from "../src/sources/claude";

describe("determineOutcome", () => {
  test("correctly categorizes outcomes", () => {
    expect(determineOutcome([
      { command: "git status", raw_command: "git status", ts: "1", is_error: false }
    ])).toBe("read_only");

    expect(determineOutcome([
      { command: "git status", raw_command: "git status", ts: "1", is_error: false },
      { command: "git commit", raw_command: "git commit", ts: "2", is_error: false }
    ])).toBe("commit");

    expect(determineOutcome([
      { command: "git commit", raw_command: "git commit", ts: "1", is_error: true }
    ])).toBe("failed_commit");

    expect(determineOutcome([
      { command: "git push", raw_command: "git push", ts: "1", is_error: true }
    ])).toBe("failed_push");
  });
});

describe("isOrchestratorIntent", () => {
  test("identifies orchestrator prefix strings", () => {
    expect(isOrchestratorIntent("<task-notification> Task standard")).toBe(true);
    expect(isOrchestratorIntent("CMUX agent handoff: To: surface:31")).toBe(true);
    expect(isOrchestratorIntent("   Caveat: do not reply")).toBe(true);
    expect(isOrchestratorIntent("Please commit the files")).toBe(false);
  });
});

describe("parseEpisodes with lazy ops & context ops", () => {
  test("excludes pre-git ops, excludes trailing turns, and charges interleaved turns", async () => {
    const events: UnifiedEvent[] = [
      {
        role: "user",
        text: "Please commit our changes", // Human intent
        ts: "2026-07-06T00:00:01.000Z"
      },
      // Turn A (non-git before first git command): pre-git context turn!
      {
        role: "assistant",
        thinking: [],
        text: ["First, let me run a check"],
        tool_calls: [{ name: "Bash", input: { command: "npm run lint" }, id: "tool_lint" }],
        ts: "2026-07-06T00:00:01.500Z"
      },
      {
        role: "tool",
        tool_results: [{ tool_use_id: "tool_lint", content: "ok", is_error: false }],
        ts: "2026-07-06T00:00:01.800Z"
      },
      // Turn B (first git command): starts the episode!
      {
        role: "assistant",
        thinking: ["I should check status first"],
        text: ["Checking repo status."],
        tool_calls: [
          { name: "Bash", input: { command: "git status" }, id: "tool_status" }
        ],
        ts: "2026-07-06T00:00:02.000Z"
      },
      {
        role: "tool",
        tool_results: [
          { tool_use_id: "tool_status", content: "modified: README.md", is_error: false }
        ],
        ts: "2026-07-06T00:00:03.000Z"
      },
      // Turn C (interleaved non-git turn): should be charged since a subsequent git turn happens!
      {
        role: "assistant",
        thinking: ["Let me read the README just in case"],
        text: ["Reading README."],
        tool_calls: [{ name: "Bash", input: { command: "cat README.md" }, id: "tool_cat" }],
        ts: "2026-07-06T00:00:03.500Z"
      },
      {
        role: "tool",
        tool_results: [{ tool_use_id: "tool_cat", content: "readme content", is_error: false }],
        ts: "2026-07-06T00:00:03.800Z"
      },
      // Turn D (second git command): commits the change!
      {
        role: "assistant",
        thinking: ["Now I'll commit"],
        text: ["Committing..."],
        tool_calls: [
          { name: "Bash", input: { command: "git add README.md && git commit -m 'update'" }, id: "tool_commit" }
        ],
        ts: "2026-07-06T00:00:04.000Z"
      },
      {
        role: "tool",
        tool_results: [
          { tool_use_id: "tool_commit", content: "[main abc1234] update", is_error: false }
        ],
        ts: "2026-07-06T00:00:05.000Z"
      },
      // Turn E (trailing non-git turn 1): should be excluded!
      {
        role: "assistant",
        thinking: ["I will run tests now"],
        text: ["Running tests."],
        tool_calls: [
          { name: "Bash", input: { command: "bun test" }, id: "tool_test" }
        ],
        ts: "2026-07-06T00:00:06.000Z"
      },
      {
        role: "tool",
        tool_results: [
          { tool_use_id: "tool_test", content: "All tests passed", is_error: false }
        ],
        ts: "2026-07-06T00:00:07.000Z"
      },
      // Turn F (trailing non-git turn 2): should be excluded!
      {
        role: "assistant",
        thinking: [],
        text: ["Checking other things"],
        tool_calls: [],
        ts: "2026-07-06T00:00:08.000Z"
      }
    ];

    async function* makeGenerator() {
      for (const ev of events) yield ev;
    }

    const episodes = await parseEpisodes(makeGenerator(), "session_1");

    expect(episodes.length).toBe(1);
    const ep = episodes[0]!;
    expect(ep.session_id).toBe("session_1");
    expect(ep.intent).toBe("Please commit our changes");
    expect(ep.intent_source).toBe("human");
    expect(ep.shape).toBe("status>add>commit");
    expect(ep.outcome).toBe("commit");
    
    // Steps check
    expect(ep.steps.length).toBe(3);
    expect(ep.steps[0]!.command).toBe("git status");
    expect(ep.steps[1]!.command).toBe("git add README.md");
    expect(ep.steps[2]!.command).toBe("git commit -m 'update'");

    // Ops analysis:
    // Turn A (Lint check): 1 assistant + 1 tool call = 2 ops. This is pre-git, so context_ops = 2.
    // Turn B (git status): 1 assistant + 1 tool call = 2 ops. Inside episode.
    // Turn C (cat README): 1 assistant + 1 tool call = 2 ops. Interleaved, so charged because Turn D has git.
    // Turn D (git commit): 1 assistant + 1 tool call = 2 ops. Inside episode.
    // Turn E, F: Trailing non-git. Excluded.
    // Total llm_ops = Turn B + Turn C + Turn D = 2 + 2 + 2 = 6 ops.
    expect(ep.llm_ops).toBe(6);
    expect(ep.context_ops).toBe(2);
  });

  test("uses human intent even if latest user message is from orchestrator", async () => {
    const events: UnifiedEvent[] = [
      {
        role: "user",
        text: "Please push the clean changes", // Human intent
        ts: "2026-07-06T00:00:01.000Z"
      },
      {
        role: "assistant",
        thinking: [],
        text: ["Okay"],
        tool_calls: [],
        ts: "2026-07-06T00:00:02.000Z"
      },
      {
        role: "user",
        text: "CMUX agent handoff: To: surface:31", // Orchestrator intent
        ts: "2026-07-06T00:00:03.000Z"
      },
      {
        role: "assistant",
        thinking: [],
        text: ["Running push."],
        tool_calls: [{ name: "Bash", input: { command: "git push" }, id: "tool_push" }],
        ts: "2026-07-06T00:00:04.000Z"
      }
    ];

    async function* makeGenerator() {
      for (const ev of events) yield ev;
    }

    const episodes = await parseEpisodes(makeGenerator(), "session_2");
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.intent).toBe("Please push the clean changes");
    expect(episodes[0]!.intent_source).toBe("human");
  });

  test("compound command exit code mapping: marks only the last git step as error", async () => {
    const events: UnifiedEvent[] = [
      {
        role: "user",
        text: "Please commit our changes",
        ts: "2026-07-06T00:00:01.000Z"
      },
      {
        role: "assistant",
        thinking: [],
        text: ["Committing..."],
        tool_calls: [
          { name: "Bash", input: { command: "git add README.md && git commit -m 'update'" }, id: "tool_commit" }
        ],
        ts: "2026-07-06T00:00:02.000Z"
      },
      {
        role: "tool",
        tool_results: [
          { tool_use_id: "tool_commit", content: "some commit error", is_error: true }
        ],
        ts: "2026-07-06T00:00:03.000Z"
      }
    ];

    async function* makeGenerator() {
      for (const ev of events) yield ev;
    }

    const episodes = await parseEpisodes(makeGenerator(), "session_3");
    expect(episodes.length).toBe(1);
    const ep = episodes[0]!;
    expect(ep.steps.length).toBe(2);
    
    // First step: git add README.md
    expect(ep.steps[0]!.command).toBe("git add README.md");
    expect(ep.steps[0]!.is_error).toBe(false);
    expect(ep.steps[0]!.exit_code).toBe(0);

    // Second (last) step: git commit -m 'update'
    expect(ep.steps[1]!.command).toBe("git commit -m 'update'");
    expect(ep.steps[1]!.is_error).toBe(true);
    expect(ep.steps[1]!.exit_code).toBe(1);
  });
});
