import type { Database } from "bun:sqlite";

interface SemanticRow {
  operation: string;
  client: string;
  transport: string;
  backend: string;
  duration_ms: number;
  git_subprocess_count: number;
  result_code: string;
  usable_git_version: string;
  client_version: string;
}

interface RawFallbackRow {
  client: string;
  applicable_operation: string | null;
  result_code: string;
  raw_git_operations: number;
  repeated_read_count: number;
  estimated_git_tokens: number;
  duration_ms: number | null;
}

const sortedCounts = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
};

const percentile = (values: number[], percentage: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (percentage === 0.5 && sorted.length % 2 === 0) {
    const right = sorted.length / 2;
    return (sorted[right - 1]! + sorted[right]!) / 2;
  }
  const index = Math.max(0, Math.ceil(percentage * sorted.length) - 1);
  return sorted[index]!;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export interface AdoptionReport {
  adoption: {
    semanticInvocations: number;
    applicableRawFallbacks: number;
    nonApplicableRawOperations: number;
    semanticAdoptionRate: number;
  };
  repeatedReads: {
    observedRawRepeats: number;
    semanticReadInvocations: number;
  };
  correctness: {
    successfulOutcomes: number;
    totalOutcomes: number;
    successRate: number;
    recoveryOutcomes: Record<string, number>;
  };
  agentFacingOperations: { semantic: number; raw: number; total: number };
  gitSubprocesses: { semantic: number; raw: number; total: number };
  estimatedGitTokens: { semantic: null; raw: number };
  latencyMs: {
    semanticMedian: number | null;
    semanticP95: number | null;
    rawMedian: number | null;
    rawP95: number | null;
  };
  outcomes: Record<string, number>;
  distributions: {
    clients: Record<string, number>;
    transports: Record<string, number>;
    backends: Record<string, number>;
    versions: Record<string, number>;
    clientVersions: Record<string, number>;
  };
}

export const generateAdoptionReport = (database: Database): AdoptionReport => {
  const semantic = database
    .query(`
      SELECT operation, client, transport, backend, duration_ms, git_subprocess_count,
             result_code, usable_git_version, client_version
      FROM semantic_events
    `)
    .all() as SemanticRow[];
  const raw = database
    .query(`
      SELECT client, applicable_operation, result_code, raw_git_operations,
             repeated_read_count, estimated_git_tokens, duration_ms
      FROM raw_fallbacks
    `)
    .all() as RawFallbackRow[];
  const applicableRaw = raw.filter((row) => row.applicable_operation !== null).length;
  const adoptionDenominator = semantic.length + applicableRaw;
  const semanticAgentOperations = semantic.length;
  const rawAgentOperations = sum(raw.map((row) => row.raw_git_operations));
  const outcomes = sortedCounts([
    ...semantic.map((row) => row.result_code),
    ...raw.map((row) => row.result_code),
  ]);
  const successfulOutcomes = outcomes.success ?? 0;
  const totalOutcomes = semantic.length + raw.length;
  const recoveryOutcomes = Object.fromEntries(
    Object.entries(outcomes).filter(([code]) =>
      ["NETWORK_AMBIGUITY", "RECOVERY_CONFLICT", "INVARIANT_VIOLATION"].includes(code),
    ),
  );

  return {
    adoption: {
      semanticInvocations: semantic.length,
      applicableRawFallbacks: applicableRaw,
      nonApplicableRawOperations: raw.length - applicableRaw,
      semanticAdoptionRate: adoptionDenominator === 0 ? 0 : semantic.length / adoptionDenominator,
    },
    repeatedReads: {
      observedRawRepeats: sum(raw.map((row) => row.repeated_read_count)),
      semanticReadInvocations: semantic.filter((row) =>
        ["inspect", "review", "history"].includes(row.operation),
      ).length,
    },
    correctness: {
      successfulOutcomes,
      totalOutcomes,
      successRate: totalOutcomes === 0 ? 0 : successfulOutcomes / totalOutcomes,
      recoveryOutcomes,
    },
    agentFacingOperations: {
      semantic: semanticAgentOperations,
      raw: rawAgentOperations,
      total: semanticAgentOperations + rawAgentOperations,
    },
    gitSubprocesses: {
      semantic: sum(semantic.map((row) => row.git_subprocess_count)),
      raw: rawAgentOperations,
      total: sum(semantic.map((row) => row.git_subprocess_count)) + rawAgentOperations,
    },
    estimatedGitTokens: {
      semantic: null,
      raw: sum(raw.map((row) => row.estimated_git_tokens)),
    },
    latencyMs: {
      semanticMedian: percentile(semantic.map((row) => row.duration_ms), 0.5),
      semanticP95: percentile(semantic.map((row) => row.duration_ms), 0.95),
      rawMedian: percentile(
        raw.flatMap((row) => (row.duration_ms === null ? [] : [row.duration_ms])),
        0.5,
      ),
      rawP95: percentile(
        raw.flatMap((row) => (row.duration_ms === null ? [] : [row.duration_ms])),
        0.95,
      ),
    },
    outcomes,
    distributions: {
      clients: sortedCounts([...semantic.map((row) => row.client), ...raw.map((row) => row.client)]),
      transports: sortedCounts([...semantic.map((row) => row.transport), ...raw.map(() => "raw")]),
      backends: sortedCounts([...semantic.map((row) => row.backend), ...raw.map(() => "raw")]),
      versions: sortedCounts([
        ...semantic.map((row) => `usable-git@${row.usable_git_version}`),
        ...raw.map(() => "legacy"),
      ]),
      clientVersions: sortedCounts([
        ...semantic.map((row) => `${row.client}@${row.client_version}`),
        ...raw.map((row) => `${row.client}@legacy`),
      ]),
    },
  };
};
