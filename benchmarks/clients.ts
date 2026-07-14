import { readFile } from "node:fs/promises";

export const benchmarkClientIds = ["codex", "claude-code", "cursor", "devin"] as const;
export type BenchmarkClientId = (typeof benchmarkClientIds)[number];

export type BenchmarkClientInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  artifactPath?: string;
  timeoutMs: number;
};

export type BenchmarkClientProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifactJson?: string;
};

export type BenchmarkClientProcessRunner = (
  request: BenchmarkClientInvocation,
) => Promise<BenchmarkClientProcessResult>;

export type ClientTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number;
  source: `${BenchmarkClientId}-json-usage`;
};

export type ClientEvidence = {
  structured: boolean;
  terminalSuccess: boolean;
  semanticToolCalls: number;
  rawGitToolCalls: number;
  agentFacingOperations: number;
  gitSubprocesses: {
    value: number | null;
    source:
      | "service-envelope"
      | "structured-command"
      | "mixed-structured-evidence"
      | "unavailable";
  };
  tokenUsage: ClientTokenUsage | null;
  errors: string[];
};

export type RunBenchmarkClientSessionInput = {
  client: BenchmarkClientId;
  repoPath: string;
  prompt: string;
  artifactPath: string;
  mutating: boolean;
  expectedMethod: "raw-git" | "semantic";
  processRunner?: BenchmarkClientProcessRunner;
};

export type BenchmarkClientSessionResult = {
  durationMs: number;
  success: boolean;
  outcome: string;
  semanticAdopted: boolean;
  semanticToolCalls: number;
  rawGitToolCalls: number;
  agentFacingOperations: number;
  gitSubprocesses: ClientEvidence["gitSubprocesses"];
  gitRelatedTokens: {
    value: number | null;
    source: "measured" | "unavailable";
    scope: "isolated-git-task-session-total";
    inputTokens: number | null;
    outputTokens: number | null;
  };
  evidenceErrors: string[];
};

type InvocationInput = {
  repoPath: string;
  prompt: string;
  artifactPath: string;
  mutating: boolean;
};

type JsonRecord = Record<string, unknown>;
type ParsedToolCall = {
  id: string;
  semantic: boolean;
  rawGit: boolean;
  serviceGitSubprocesses: number | null;
  commandGitSubprocesses: number | null;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizedEnvironment = () => {
  const entries = Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || key === "ANTHROPIC_API_KEY" ? [] : [[key, value] as const]
  );
  return {
    ...Object.fromEntries(entries),
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
};

export const createClientInvocation = (
  client: BenchmarkClientId,
  { repoPath, prompt, artifactPath, mutating }: InvocationInput,
): BenchmarkClientInvocation => {
  const common = {
    cwd: repoPath,
    env: sanitizedEnvironment(),
    timeoutMs: 120_000,
  };
  if (client === "codex") {
    return {
      ...common,
      command: "codex",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--color",
        "never",
        "--sandbox",
        mutating ? "workspace-write" : "read-only",
        "--skip-git-repo-check",
        "-C",
        repoPath,
        prompt,
      ],
    };
  }
  if (client === "claude-code") {
    return {
      ...common,
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Bash,mcp__usable-git__*",
        prompt,
      ],
    };
  }
  if (client === "cursor") {
    return {
      ...common,
      command: "agent",
      args: [
        "-p",
        "--force",
        "--sandbox",
        "enabled",
        "--trust",
        "--approve-mcps",
        "--output-format",
        "stream-json",
        "--workspace",
        repoPath,
        prompt,
      ],
    };
  }
  return {
    ...common,
    command: "devin",
    args: [
      "--permission-mode",
      mutating ? "dangerous" : "auto",
      "--sandbox",
      "--respect-workspace-trust",
      "false",
      "--export",
      artifactPath,
      "-p",
      prompt,
    ],
    artifactPath,
  };
};

const defaultProcessRunner: BenchmarkClientProcessRunner = async (request) => {
  const startedAt = performance.now();
  try {
    const child = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timeout);
    let artifactJson: string | undefined;
    if (request.artifactPath) {
      artifactJson = await readFile(request.artifactPath, "utf8").catch(() => undefined);
    }
    return {
      exitCode: timedOut ? 124 : exitCode,
      stdout,
      stderr,
      durationMs: performance.now() - startedAt,
      ...(artifactJson === undefined ? {} : { artifactJson }),
    };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.name : "spawn-error",
      durationMs: performance.now() - startedAt,
    };
  }
};

export const createBenchmarkClientProcessRunner = (): BenchmarkClientProcessRunner =>
  defaultProcessRunner;

const parseJsonText = (text: string) => {
  const records: unknown[] = [];
  let invalid = 0;
  for (const line of text.split(/\r?\n/).filter((value) => value.trim().length > 0)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      invalid += 1;
    }
  }
  return { records, invalid };
};

const valuesForKey = (value: unknown, key: string): unknown[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => valuesForKey(entry, key));
  if (!isRecord(value)) return [];
  return [
    ...(Object.hasOwn(value, key) ? [value[key]] : []),
    ...Object.values(value).flatMap((entry) => valuesForKey(entry, key)),
  ];
};

const stringsWithin = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsWithin);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(stringsWithin);
};

const finiteToken = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const tokenFromAliases = (usage: JsonRecord, aliases: string[]) => {
  for (const alias of aliases) {
    const value = finiteToken(usage[alias]);
    if (value !== null) return value;
  }
  return null;
};

const tokenUsageFrom = (
  client: BenchmarkClientId,
  records: unknown[],
): ClientTokenUsage | null => {
  const candidates = records.flatMap((record) => valuesForKey(record, "usage"))
    .filter(isRecord)
    .flatMap((usage) => {
      const inputTokens = tokenFromAliases(usage, ["input_tokens", "inputTokens"]);
      const outputTokens = tokenFromAliases(usage, ["output_tokens", "outputTokens"]);
      const explicitTotal = tokenFromAliases(usage, ["total_tokens", "totalTokens"]);
      const totalTokens = explicitTotal ?? (
        inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
      );
      return totalTokens === null
        ? []
        : [{
            inputTokens,
            outputTokens,
            totalTokens,
            source: `${client}-json-usage` as const,
          }];
    });
  return candidates.at(-1) ?? null;
};

const semanticTool = (value: unknown) => {
  const joined = stringsWithin(value).join("\n");
  return /(?:mcp__|server[\s:/_-]*)?usable-git(?:__|[\s:/_-]+)(inspect|review|history|publish|push)\b/i
    .test(joined) || (
      /usable-git/i.test(joined) && /\b(inspect|review|history|publish|push)\b/i.test(joined)
    );
};

const rawGitCommandCount = (command: unknown) => {
  if (typeof command !== "string") return 0;
  return command.match(/(?:^|[;&|]\s*|\n\s*)git(?=\s|$)/g)?.length ?? 0;
};

const numericMetric = (value: unknown) => {
  const values = valuesForKey(value, "gitSubprocessCount").flatMap((entry) => {
    const metric = finiteToken(entry);
    return metric === null ? [] : [metric];
  });
  return values.length === 0 ? null : Math.max(...values);
};

const toolFrom = (
  id: unknown,
  name: unknown,
  input: unknown,
  result: unknown,
): ParsedToolCall => {
  const command = isRecord(input)
    ? input.command ?? input.cmd
    : valuesForKey(input, "command")[0] ?? valuesForKey(input, "cmd")[0];
  const gitCommands = rawGitCommandCount(command);
  return {
    id: typeof id === "string" ? id : `anonymous-${String(name)}`,
    semantic: semanticTool({ name, input }),
    rawGit: gitCommands > 0,
    serviceGitSubprocesses: numericMetric(result),
    commandGitSubprocesses: gitCommands > 0 ? gitCommands : null,
  };
};

const codexCalls = (records: unknown[]) => records.flatMap((record) => {
  if (!isRecord(record) || record.type !== "item.completed" || !isRecord(record.item)) return [];
  const item = record.item;
  if (item.type === "mcp_tool_call") {
    return [toolFrom(
      item.id,
      `${String(item.server ?? "")}__${String(item.tool ?? item.name ?? "")}`,
      item.arguments ?? item.input,
      item.result,
    )];
  }
  if (item.type === "command_execution") {
    return [toolFrom(item.id, "command_execution", { command: item.command }, item)];
  }
  return [];
});

const contentToolCalls = (value: unknown) => valuesForKey(value, "content")
  .flatMap((content) => Array.isArray(content) ? content : [])
  .flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "tool_use") return [];
    return [toolFrom(entry.id, entry.name, entry.input, entry.result)];
  });

const claudeCalls = (records: unknown[]) => records.flatMap((record) => {
  if (!isRecord(record) || record.type !== "assistant") return [];
  return contentToolCalls(record.message);
});

const cursorCalls = (records: unknown[]) => records.flatMap((record) => {
  if (
    !isRecord(record) || record.type !== "tool_call" || record.subtype !== "completed" ||
    !isRecord(record.tool_call)
  ) return [];
  return Object.entries(record.tool_call).map(([name, call]) => {
    const details = isRecord(call) ? call : {};
    return toolFrom(record.call_id, name, details.args, details.result);
  });
});

const devinCalls = (records: unknown[]) => [
  ...contentToolCalls(records),
  ...cursorCalls(records),
  ...codexCalls(records),
];

const terminalSucceeded = (client: BenchmarkClientId, records: unknown[]) =>
  records.some((record) => {
    if (!isRecord(record)) return false;
    if (client === "codex") return record.type === "turn.completed";
    if (client === "claude-code") {
      return record.type === "result" && record.is_error !== true && record.subtype !== "error";
    }
    if (client === "cursor") {
      return record.type === "result" && record.is_error !== true && record.subtype === "success";
    }
    return (record.type === "result" || record.status === "completed") && record.is_error !== true;
  });

export const parseClientEvidence = (
  client: BenchmarkClientId,
  result: Pick<BenchmarkClientProcessResult, "exitCode" | "stdout" | "stderr"> & {
    artifactJson?: string;
  },
): ClientEvidence => {
  const stdout = parseJsonText(result.stdout);
  const artifact = parseJsonText(result.artifactJson ?? "");
  const records = [...stdout.records, ...artifact.records];
  const calls = client === "codex"
    ? codexCalls(records)
    : client === "claude-code"
      ? claudeCalls(records)
      : client === "cursor"
        ? cursorCalls(records)
        : devinCalls(records);
  const uniqueCalls = [...new Map(calls.map((call) => [call.id, call])).values()];
  const semanticToolCalls = uniqueCalls.filter(({ semantic }) => semantic).length;
  const rawGitToolCalls = uniqueCalls.filter(({ rawGit }) => rawGit).length;
  const serviceCounts = uniqueCalls.flatMap(({ serviceGitSubprocesses }) =>
    serviceGitSubprocesses === null ? [] : [serviceGitSubprocesses]
  );
  const commandCounts = uniqueCalls.flatMap(({ commandGitSubprocesses }) =>
    commandGitSubprocesses === null ? [] : [commandGitSubprocesses]
  );
  const serviceTotal = serviceCounts.reduce((sum, value) => sum + value, 0);
  const commandTotal = commandCounts.reduce((sum, value) => sum + value, 0);
  const gitSubprocesses = serviceCounts.length > 0 && commandCounts.length > 0
    ? { value: serviceTotal + commandTotal, source: "mixed-structured-evidence" as const }
    : serviceCounts.length > 0
      ? { value: serviceTotal, source: "service-envelope" as const }
      : commandCounts.length > 0
        ? { value: commandTotal, source: "structured-command" as const }
        : { value: null, source: "unavailable" as const };
  const structured = records.length > 0;
  const tokenUsage = tokenUsageFrom(client, records);
  const terminalSuccess = result.exitCode === 0 && terminalSucceeded(client, records);
  const errors = [
    ...(!structured ? ["no parseable structured client evidence"] : []),
    ...(tokenUsage === null ? ["client JSON did not expose complete token usage"] : []),
    ...(!terminalSuccess ? ["client did not emit a successful terminal event"] : []),
    ...(structured && uniqueCalls.length === 0 ? ["client did not emit completed structured tool calls"] : []),
  ];
  return {
    structured,
    terminalSuccess,
    semanticToolCalls,
    rawGitToolCalls,
    agentFacingOperations: uniqueCalls.length,
    gitSubprocesses,
    tokenUsage,
    errors,
  };
};

export const runBenchmarkClientSession = async ({
  client,
  repoPath,
  prompt,
  artifactPath,
  mutating,
  expectedMethod,
  processRunner = defaultProcessRunner,
}: RunBenchmarkClientSessionInput): Promise<BenchmarkClientSessionResult> => {
  const processResult = await processRunner(createClientInvocation(client, {
    repoPath,
    prompt,
    artifactPath,
    mutating,
  }));
  const evidence = parseClientEvidence(client, processResult);
  const semanticAdopted = evidence.semanticToolCalls > 0 && evidence.rawGitToolCalls === 0;
  const expectedToolsObserved = expectedMethod === "semantic"
    ? semanticAdopted
    : evidence.rawGitToolCalls > 0 && evidence.semanticToolCalls === 0;
  const success = evidence.terminalSuccess && expectedToolsObserved;
  return {
    durationMs: processResult.durationMs,
    success,
    outcome: success ? "client-session-completed" : "client-evidence-failed",
    semanticAdopted,
    semanticToolCalls: evidence.semanticToolCalls,
    rawGitToolCalls: evidence.rawGitToolCalls,
    agentFacingOperations: evidence.agentFacingOperations,
    gitSubprocesses: evidence.gitSubprocesses,
    gitRelatedTokens: {
      value: evidence.tokenUsage?.totalTokens ?? null,
      source: evidence.tokenUsage ? "measured" : "unavailable",
      scope: "isolated-git-task-session-total",
      inputTokens: evidence.tokenUsage?.inputTokens ?? null,
      outputTokens: evidence.tokenUsage?.outputTokens ?? null,
    },
    evidenceErrors: evidence.errors,
  };
};
