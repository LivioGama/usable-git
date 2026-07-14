import { describe, expect, test } from "bun:test";
import {
  benchmarkClientIds,
  createClientInvocation,
  parseClientEvidence,
  runBenchmarkClientSession,
  type BenchmarkClientProcessRunner,
} from "../../../benchmarks/clients.ts";

describe("real benchmark client adapters", () => {
  test("builds non-interactive structured invocations for every supported client", () => {
    const inputs = {
      repoPath: "/tmp/repo",
      prompt: "perform the isolated Git task",
      artifactPath: "/tmp/devin-export.json",
      mutating: true,
    };
    expect(benchmarkClientIds).toEqual(["codex", "claude-code", "cursor", "devin"]);
    const invocations = {
      codex: createClientInvocation("codex", inputs),
      "claude-code": createClientInvocation("claude-code", inputs),
      cursor: createClientInvocation("cursor", inputs),
      devin: createClientInvocation("devin", inputs),
    };

    expect(invocations.codex.command).toBe("codex");
    expect(invocations.codex.args).toContain("--json");
    expect(invocations.codex.args).toContain("--ephemeral");
    expect(invocations["claude-code"].command).toBe("claude");
    expect(invocations["claude-code"].args).toContain("stream-json");
    expect(invocations["claude-code"].args).toContain("--no-session-persistence");
    expect(invocations.cursor.command).toBe("agent");
    expect(invocations.cursor.args).toContain("stream-json");
    expect(invocations.cursor.args).toContain("--approve-mcps");
    expect(invocations.devin.command).toBe("devin");
    expect(invocations.devin.args).toContain("--export");
    expect(invocations.devin.artifactPath).toBe("/tmp/devin-export.json");
    expect(Object.hasOwn(invocations.codex.env, "ANTHROPIC_API_KEY")).toBe(false);
  });

  test("extracts measured Codex semantic calls, service subprocesses, and aggregate usage", () => {
    const evidence = parseClientEvidence("codex", {
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "call-1",
            type: "mcp_tool_call",
            server: "usable-git",
            tool: "inspect",
            result: { structuredContent: { metrics: { gitSubprocessCount: 2 } } },
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 },
        }),
      ].join("\n"),
    });

    expect(evidence.structured).toBe(true);
    expect(evidence.semanticToolCalls).toBe(1);
    expect(evidence.rawGitToolCalls).toBe(0);
    expect(evidence.agentFacingOperations).toBe(1);
    expect(evidence.gitSubprocesses).toEqual({ value: 2, source: "service-envelope" });
    expect(evidence.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      source: "codex-json-usage",
    });
  });

  test("extracts Claude raw Git calls and measured result usage without retaining commands", () => {
    const evidence = parseClientEvidence("claude-code", {
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "git status --porcelain=v2" },
            }],
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 90, output_tokens: 10 },
        }),
      ].join("\n"),
    });

    expect(evidence.rawGitToolCalls).toBe(1);
    expect(evidence.gitSubprocesses).toEqual({ value: 1, source: "structured-command" });
    expect(evidence.tokenUsage?.totalTokens).toBe(100);
    expect(JSON.stringify(evidence)).not.toContain("git status");
  });

  test("uses completed Cursor MCP events and fails token evidence when JSON omits usage", () => {
    const evidence = parseClientEvidence("cursor", {
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", model: "test" }),
        JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "cursor-call-1",
          tool_call: {
            mcpToolCall: {
              args: { server: "usable-git", tool: "inspect" },
              result: { success: { metrics: { gitSubprocessCount: 3 } } },
            },
          },
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ].join("\n"),
    });

    expect(evidence.semanticToolCalls).toBe(1);
    expect(evidence.gitSubprocesses.value).toBe(3);
    expect(evidence.tokenUsage).toBeNull();
    expect(evidence.errors).toContain("client JSON did not expose complete token usage");
  });

  test("reads Devin export evidence and rejects unstructured successful stdout", () => {
    const exported = parseClientEvidence("devin", {
      exitCode: 0,
      stderr: "",
      stdout: "done",
      artifactJson: JSON.stringify({
        type: "result",
        usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
        messages: [{
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "devin-call-1",
            name: "mcp__usable-git__inspect",
            input: {},
          }],
        }],
      }),
    });
    const unstructured = parseClientEvidence("devin", {
      exitCode: 0,
      stderr: "",
      stdout: "looks good",
    });

    expect(exported.semanticToolCalls).toBe(1);
    expect(exported.tokenUsage?.totalTokens).toBe(48);
    expect(unstructured.structured).toBe(false);
    expect(unstructured.tokenUsage).toBeNull();
    expect(unstructured.errors).toContain("no parseable structured client evidence");
  });

  test("runs through an injected process adapter and proves semantic adoption", async () => {
    const requests: Array<{ command: string; args: string[] }> = [];
    const runner: BenchmarkClientProcessRunner = async (request) => {
      requests.push({ command: request.command, args: request.args });
      return {
        exitCode: 0,
        durationMs: 12,
        stderr: "",
        stdout: [
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "call-1",
              type: "mcp_tool_call",
              server: "usable-git",
              tool: "inspect",
              result: { metrics: { gitSubprocessCount: 2 } },
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 20, output_tokens: 5 },
          }),
        ].join("\n"),
      };
    };

    const result = await runBenchmarkClientSession({
      client: "codex",
      repoPath: "/tmp/repo",
      prompt: "inspect through usable-git",
      artifactPath: "/tmp/export.json",
      mutating: false,
      expectedMethod: "semantic",
      processRunner: runner,
    });

    expect(requests).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.semanticAdopted).toBe(true);
    expect(result.gitRelatedTokens.value).toBe(25);
    expect(result.gitRelatedTokens.scope).toBe("isolated-git-task-session-total");
  });
});
