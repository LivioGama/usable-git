import { open } from "node:fs/promises";

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
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  artifactTruncated?: boolean;
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
  semanticOperations: string[];
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
  expectedSemanticOperations?: string[];
  expectedRawGitToolCalls?: number;
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
  semantic?: boolean;
};

type JsonRecord = Record<string, unknown>;
type ParsedToolCall = {
  id: string;
  kind: "mcp" | "command" | "other";
  semantic: boolean;
  semanticOperation: string | null;
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
  { repoPath, prompt, artifactPath, mutating, semantic = false }: InvocationInput,
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
      mutating || semantic ? "dangerous" : "auto",
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

type ProcessRunnerOptions = { maxOutputBytes?: number };
type BoundedText = { value: string; truncated: boolean };

const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLimit: () => void,
): Promise<BoundedText> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - size;
    if (remaining > 0) {
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    if (value.byteLength > remaining) {
      truncated = true;
      onLimit();
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { value: new TextDecoder().decode(bytes), truncated };
};

const readBoundedFile = async (path: string, limit: number): Promise<BoundedText | undefined> => {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const bytes = new Uint8Array(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    return {
      value: new TextDecoder().decode(bytes.subarray(0, Math.min(bytesRead, limit))),
      truncated: bytesRead > limit,
    };
  } finally {
    await handle.close();
  }
};

const createProcessRunner = ({
  maxOutputBytes = 4 * 1024 * 1024,
}: ProcessRunnerOptions = {}): BenchmarkClientProcessRunner => async (request) => {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  const startedAt = performance.now();
  try {
    const child = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd,
      detached: true,
      env: request.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminated = false;
    const terminate = () => {
      if (terminated || child.exitCode !== null) return;
      terminated = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else {
          process.kill(-child.pid, "SIGKILL");
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timeout.unref();
    const onOutputLimit = () => {
      outputLimitExceeded = true;
      terminate();
    };
    const [stdout, stderr, rawExitCode] = await Promise.all([
      readBoundedStream(child.stdout, maxOutputBytes, onOutputLimit),
      readBoundedStream(child.stderr, maxOutputBytes, onOutputLimit),
      child.exited,
    ]).finally(() => clearTimeout(timeout));
    const artifact = request.artifactPath
      ? await readBoundedFile(request.artifactPath, maxOutputBytes)
      : undefined;
    if (artifact?.truncated) outputLimitExceeded = true;
    const exitCode = timedOut ? 124 : outputLimitExceeded ? 125 : rawExitCode;
    return {
      exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      durationMs: performance.now() - startedAt,
      ...(artifact === undefined ? {} : { artifactJson: artifact.value }),
      ...(stdout.truncated ? { stdoutTruncated: true } : {}),
      ...(stderr.truncated ? { stderrTruncated: true } : {}),
      ...(artifact?.truncated ? { artifactTruncated: true } : {}),
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

const defaultProcessRunner = createProcessRunner();

export const createBenchmarkClientProcessRunner = (
  options: ProcessRunnerOptions = {},
): BenchmarkClientProcessRunner => createProcessRunner(options);

const parseJsonText = (text: string) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { records: [] as unknown[], invalid: 0 };
  try {
    return { records: [JSON.parse(trimmed)] as unknown[], invalid: 0 };
  } catch {
    // Structured clients normally emit NDJSON; Devin exports may be one pretty JSON document.
  }
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

const semanticOperation = (value: unknown) => {
  const joined = stringsWithin(value).join("\n");
  if (!/usable-git/i.test(joined)) return null;
  return ["inspect", "review", "history", "publish", "push"]
    .find((operation) => new RegExp(`(?:^|[^a-z])${operation}(?:[^a-z]|$)`, "i").test(joined)) ??
    null;
};

const rawGitCommandCount = (command: unknown) => {
  if (typeof command !== "string") return 0;
  return command.match(/(?:^|[;&|]\s*|\n\s*)git(?=\s|$)/g)?.length ?? 0;
};

const numericMetric = (value: unknown) => {
  let structured = value;
  if (typeof value === "string") {
    try {
      structured = JSON.parse(value);
    } catch {
      structured = null;
    }
  }
  const values = valuesForKey(structured, "gitSubprocessCount").flatMap((entry) => {
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
  kind: ParsedToolCall["kind"] = "other",
): ParsedToolCall => {
  const command = isRecord(input)
    ? input.command ?? input.cmd
    : valuesForKey(input, "command")[0] ?? valuesForKey(input, "cmd")[0];
  const gitCommands = rawGitCommandCount(command);
  const operation = semanticOperation({ name, input });
  return {
    id: typeof id === "string" ? id : `anonymous-${String(name)}`,
    kind,
    semantic: operation !== null,
    semanticOperation: operation,
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
      "mcp",
    )];
  }
  if (item.type === "command_execution") {
    return [toolFrom(item.id, "command_execution", { command: item.command }, item, "command")];
  }
  return [];
});

const contentToolCalls = (
  value: unknown,
  resultsById = new Map<string, unknown>(),
) => valuesForKey(value, "content")
  .flatMap((content) => Array.isArray(content) ? content : [])
  .flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "tool_use") return [];
    const correlated = typeof entry.id === "string" ? resultsById.get(entry.id) : undefined;
    return [toolFrom(entry.id, entry.name, entry.input, correlated ?? entry.result)];
  });

const claudeCalls = (records: unknown[]) => {
  const resultsById = new Map<string, unknown>();
  for (const result of valuesForKey(records, "content").flatMap((content) =>
    Array.isArray(content) ? content : []
  )) {
    if (
      isRecord(result) && result.type === "tool_result" &&
      typeof result.tool_use_id === "string"
    ) resultsById.set(result.tool_use_id, result.content);
  }
  return records.flatMap((record) => {
  if (!isRecord(record) || record.type !== "assistant") return [];
    return contentToolCalls(record.message, resultsById);
  });
};

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
  const semanticOperations = uniqueCalls.flatMap(({ semanticOperation }) =>
    semanticOperation === null ? [] : [semanticOperation]
  );
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
  const completedCodexTimeout = client === "codex" && result.exitCode === 124 &&
    uniqueCalls.some(({ kind }) => kind === "mcp");
  const terminalSuccess = (result.exitCode === 0 && terminalSucceeded(client, records)) ||
    completedCodexTimeout;
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
    semanticOperations,
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
  expectedSemanticOperations = [],
  expectedRawGitToolCalls = 1,
  processRunner = defaultProcessRunner,
}: RunBenchmarkClientSessionInput): Promise<BenchmarkClientSessionResult> => {
  const processResult = await processRunner(createClientInvocation(client, {
    repoPath,
    prompt,
    artifactPath,
    mutating,
    semantic: expectedMethod === "semantic",
  }));
  const evidence = parseClientEvidence(client, processResult);
  const semanticSequenceMatches =
    evidence.semanticOperations.length === expectedSemanticOperations.length &&
    evidence.semanticOperations.every((operation, index) =>
      operation === expectedSemanticOperations[index]
    );
  const semanticAdopted = evidence.semanticToolCalls > 0 && evidence.rawGitToolCalls === 0 &&
    (expectedSemanticOperations.length === 0 || semanticSequenceMatches);
  const expectedToolsObserved = expectedMethod === "semantic"
    ? semanticAdopted
    : evidence.rawGitToolCalls === expectedRawGitToolCalls && evidence.semanticToolCalls === 0;
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
    evidenceErrors: [
      ...evidence.errors,
      ...(expectedMethod === "semantic" && expectedSemanticOperations.length > 0 &&
          !semanticSequenceMatches
        ? [
            `expected semantic operation sequence ${expectedSemanticOperations.join(",")}, observed ${evidence.semanticOperations.join(",") || "none"}`,
          ]
        : []),
      ...(expectedMethod === "raw-git" &&
          evidence.rawGitToolCalls !== expectedRawGitToolCalls
        ? [
            `expected exactly ${expectedRawGitToolCalls} raw Git tool calls, observed ${evidence.rawGitToolCalls}`,
          ]
        : []),
    ],
  };
};
