import { describe, expect, test } from "bun:test";
import {
  benchmarkClientIds,
  createBenchmarkClientProcessRunner,
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
    expect(invocations["claude-code"].args).toContain("--model");
    expect(invocations["claude-code"].args).toContain("sonnet");
    expect(invocations["claude-code"].args).toContain("stream-json");
    expect(invocations["claude-code"].args).toContain("--no-session-persistence");
    expect(invocations.cursor.command).toBe("agent");
    expect(invocations.cursor.args).toContain("stream-json");
    expect(invocations.cursor.args).toContain("--approve-mcps");
    expect(invocations.devin.command).toBe("devin");
    expect(invocations.devin.args).toContain("--export");
    expect(invocations.devin.artifactPath).toBe("/tmp/devin-export.json");
    expect(createClientInvocation("devin", { ...inputs, mutating: false }).args).toContain("auto");
    expect(createClientInvocation("devin", {
      ...inputs,
      mutating: false,
      semantic: true,
    }).args).toContain("dangerous");
    expect(Object.hasOwn(invocations.codex.env, "ANTHROPIC_API_KEY")).toBe(false);
  });

  test("bounds captured client output and terminates the isolated process", async () => {
    const runner = createBenchmarkClientProcessRunner({ maxOutputBytes: 64 });
    const result = await runner({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096)); setTimeout(() => {}, 60000)"],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(125);
    expect(result.stdout.length).toBeLessThanOrEqual(64);
    expect(result.stdoutTruncated).toBe(true);
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

  test("accepts completed Codex tool evidence when the client hangs until timeout", async () => {
    const runner: BenchmarkClientProcessRunner = async () => ({
      exitCode: 124,
      durationMs: 120_000,
      stderr: "",
      stdout: JSON.stringify({
        type: "item.completed",
        item: {
          id: "call-timeout",
          type: "mcp_tool_call",
          server: "usable-git",
          tool: "inspect",
          status: "completed",
          result: { metrics: { gitSubprocessCount: 2 } },
        },
      }),
    });
    const result = await runBenchmarkClientSession({
      client: "codex",
      repoPath: "/tmp/repo",
      prompt: "inspect through usable-git",
      artifactPath: "/tmp/export.json",
      mutating: false,
      expectedMethod: "semantic",
      expectedSemanticOperations: ["inspect"],
      processRunner: runner,
    });

    expect(result.success).toBe(true);
    expect(result.semanticAdopted).toBe(true);
    expect(result.gitRelatedTokens.value).toBeNull();

    const rawTimeout = parseClientEvidence("codex", {
      exitCode: 124,
      stderr: "",
      stdout: JSON.stringify({
        type: "item.completed",
        item: {
          id: "raw-timeout",
          type: "command_execution",
          command: "git status --porcelain=v1",
        },
      }),
    });
    expect(rawTimeout.terminalSuccess).toBe(false);
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

  test("correlates Claude MCP tool results with service subprocess metrics", () => {
    const evidence = parseClientEvidence("claude-code", {
      exitCode: 0,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "tool-semantic",
              name: "mcp__usable-git__inspect",
              input: {},
            }],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "tool-semantic",
              content: JSON.stringify({ metrics: { gitSubprocessCount: 4 } }),
            }],
          },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      ].join("\n"),
    });

    expect(evidence.semanticOperations).toEqual(["inspect"]);
    expect(evidence.gitSubprocesses).toEqual({ value: 4, source: "service-envelope" });
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
      }, null, 2),
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

  test("requires every expected semantic operation before claiming adoption", async () => {
    const runner: BenchmarkClientProcessRunner = async () => ({
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
    });
    const result = await runBenchmarkClientSession({
      client: "codex",
      repoPath: "/tmp/repo",
      prompt: "inspect then publish through usable-git",
      artifactPath: "/tmp/export.json",
      mutating: true,
      expectedMethod: "semantic",
      expectedSemanticOperations: ["inspect", "publish"],
      processRunner: runner,
    });

    expect(result.success).toBe(false);
    expect(result.semanticAdopted).toBe(false);
    expect(result.evidenceErrors).toContain(
      "expected semantic operation sequence inspect,publish, observed inspect",
    );
  });

  test("requires the scenario's exact raw Git operation count", async () => {
    const runner: BenchmarkClientProcessRunner = async () => ({
      exitCode: 0,
      durationMs: 12,
      stderr: "",
      stdout: [
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "raw-call-1",
            type: "command_execution",
            command: "git status --porcelain=v2 --branch",
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 20, output_tokens: 5 },
        }),
      ].join("\n"),
    });
    const result = await runBenchmarkClientSession({
      client: "codex",
      repoPath: "/tmp/repo",
      prompt: "run both raw Git inspection operations",
      artifactPath: "/tmp/export.json",
      mutating: false,
      expectedMethod: "raw-git",
      expectedRawGitToolCalls: 2,
      processRunner: runner,
    });

    expect(result.success).toBe(false);
    expect(result.evidenceErrors).toContain("expected exactly 2 raw Git tool calls, observed 1");
  });

  test("rejects duplicate semantic operations instead of inflating adoption", async () => {
    const runner: BenchmarkClientProcessRunner = async () => ({
      exitCode: 0,
      durationMs: 12,
      stderr: "",
      stdout: [
        ...["call-1", "call-2"].map((id) => JSON.stringify({
          type: "item.completed",
          item: {
            id,
            type: "mcp_tool_call",
            server: "usable-git",
            tool: "inspect",
            result: { metrics: { gitSubprocessCount: 2 } },
          },
        })),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 20, output_tokens: 5 },
        }),
      ].join("\n"),
    });
    const result = await runBenchmarkClientSession({
      client: "codex",
      repoPath: "/tmp/repo",
      prompt: "inspect exactly once through usable-git",
      artifactPath: "/tmp/export.json",
      mutating: false,
      expectedMethod: "semantic",
      expectedSemanticOperations: ["inspect"],
      processRunner: runner,
    });

    expect(result.success).toBe(false);
    expect(result.semanticAdopted).toBe(false);
    expect(result.evidenceErrors).toContain(
      "expected semantic operation sequence inspect, observed inspect,inspect",
    );
  });
});
