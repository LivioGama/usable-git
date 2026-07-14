import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { inspect, type InspectResult } from "../packages/usable-git/src/operations/inspect.ts";
import { publish } from "../packages/usable-git/src/operations/publish.ts";
import { withGitMetrics } from "../packages/usable-git/src/git/runner.ts";
import {
  benchmarkClientIds,
  runBenchmarkClientSession,
  type BenchmarkClientId,
  type BenchmarkClientProcessRunner,
} from "./clients.ts";
import { summarizeMetric, type MetricSummary } from "./statistics.ts";

export const benchmarkScenarios = ["inspect-dirty", "publish-scoped"] as const;
export type BenchmarkScenario = (typeof benchmarkScenarios)[number];
export type BenchmarkMethod = "raw-git" | "semantic";

export type RepositoryOracleState = {
  statusPorcelainV1: string;
  clean: boolean;
  headTree: string | null;
  headMessage: string | null;
  indexEntries: string;
  files: Array<{ path: string; sha256: string }>;
};

export type BenchmarkTrial = {
  pairId: string;
  client: string;
  scenario: BenchmarkScenario;
  method: BenchmarkMethod;
  trial: number;
  seed: number;
  durationMs: number;
  execution: "core-fixture" | "real-client-session";
  gitSubprocesses: number | null;
  agentFacingOperations: number;
  semanticAdopted: boolean | null;
  semanticToolCalls: number | null;
  rawGitToolCalls: number | null;
  evidenceErrors: string[];
  success: boolean;
  outcome: string;
  initialStateHash: string;
  finalStateHash: string;
  finalClean: boolean;
  gitRelatedTokens: {
    value: number | null;
    source: "measured" | "unavailable";
    scope: "isolated-git-task-session-total" | "unavailable";
    inputTokens: number | null;
    outputTokens: number | null;
  };
  oracle: {
    valid: boolean;
    equivalent: boolean;
    expectedStatePreserved: boolean;
    fsck: "pass" | "fail";
  };
};

export type BenchmarkSummary = {
  client: string;
  scenario: BenchmarkScenario;
  method: BenchmarkMethod;
  trials: number;
  successRate: number;
  oraclePassRate: number;
  finalCleanRate: number;
  durationMs: MetricSummary;
  realClientSessionRate: number;
  semanticAdoptionRate: number | null;
  gitSubprocesses: MetricSummary | null;
  agentFacingOperations: MetricSummary;
  gitRelatedTokens: MetricSummary | null;
};

export type BenchmarkArtifact = {
  schemaVersion: "usable-git-benchmark-v1";
  generatedAt: string;
  environment: {
    os: { platform: string; release: string; arch: string };
    hardware: { cpuModel: string; logicalCpus: number; totalMemoryBytes: number };
    bunVersion: string;
    gitVersion: string;
    commitSha: string;
    clientVersions: Record<string, string | null>;
  };
  configuration: {
    seed: number;
    trialsPerScenarioClient: number;
    scenarios: BenchmarkScenario[];
    clients: string[];
    minimumReleaseTrials: 30;
  };
  trials: BenchmarkTrial[];
  summary: BenchmarkSummary[];
  releaseGate: {
    pass: boolean;
    reasons: string[];
  };
};

export type BenchmarkMatrixOptions = {
  clients: string[];
  scenarios?: BenchmarkScenario[];
  trials: number;
  seed: number;
  clientVersions?: Record<string, string | null>;
  allowShortRun?: boolean;
  clientProcessRunner?: BenchmarkClientProcessRunner;
};

type Fixture = { root: string; repoPath: string; stateRoot: string };
type MeasuredOutcome = {
  durationMs: number;
  gitSubprocesses: number | null;
  agentFacingOperations: number;
  success: boolean;
  outcome: string;
  execution?: "core-fixture" | "real-client-session";
  semanticAdopted?: boolean;
  semanticToolCalls?: number;
  rawGitToolCalls?: number;
  evidenceErrors?: string[];
  gitRelatedTokens?: BenchmarkTrial["gitRelatedTokens"];
};

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: "Usable Git Benchmark",
  GIT_AUTHOR_EMAIL: "benchmark@usable-git.invalid",
  GIT_COMMITTER_NAME: "Usable Git Benchmark",
  GIT_COMMITTER_EMAIL: "benchmark@usable-git.invalid",
  GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  HOME: homedir(),
  LC_ALL: "C",
};

const runGit = async (cwd: string, args: string[]) => {
  const child = Bun.spawn(["git", "--no-pager", ...args], {
    cwd,
    env: gitEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const checkedGit = async (cwd: string, args: string[]) => {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr.slice(0, 500)}`);
  }
  return result.stdout;
};

const writeFixtureFile = async (repoPath: string, path: string, contents: string) => {
  const target = join(repoPath, path);
  await mkdir(join(target, ".."), { recursive: true });
  await Bun.write(target, contents);
};

const createFixture = async (scenario: BenchmarkScenario, seed: number): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), `usable-git-benchmark-${seed}-`));
  const repoPath = join(root, "repo");
  const stateRoot = join(root, "state");
  await mkdir(repoPath);
  await checkedGit(repoPath, ["init", "--quiet", "--initial-branch=main"]);
  await checkedGit(repoPath, ["config", "user.name", "Usable Git Benchmark"]);
  await checkedGit(repoPath, ["config", "user.email", "benchmark@usable-git.invalid"]);
  await checkedGit(repoPath, ["config", "commit.gpgsign", "false"]);
  await writeFixtureFile(repoPath, "selected.txt", `base-selected-${seed}\n`);
  await writeFixtureFile(repoPath, "unrelated.txt", `base-unrelated-${seed}\n`);
  await checkedGit(repoPath, ["add", "--", "selected.txt", "unrelated.txt"]);
  await checkedGit(repoPath, ["commit", "--quiet", "-m", `fixture-${seed}`]);

  if (scenario === "inspect-dirty") {
    await writeFixtureFile(repoPath, "selected.txt", `staged-selected-${seed}\n`);
    await checkedGit(repoPath, ["add", "--", "selected.txt"]);
    await writeFixtureFile(repoPath, "selected.txt", `unstaged-selected-${seed}\n`);
    await writeFixtureFile(repoPath, "untracked.txt", `untracked-${seed}\n`);
  } else {
    await writeFixtureFile(repoPath, "selected.txt", `publish-selected-${seed}\n`);
    await writeFixtureFile(repoPath, "unrelated.txt", `staged-unrelated-${seed}\n`);
    await checkedGit(repoPath, ["add", "--", "unrelated.txt"]);
    await writeFixtureFile(repoPath, "unrelated.txt", `unstaged-unrelated-${seed}\n`);
    await writeFixtureFile(repoPath, "untracked.txt", `untracked-${seed}\n`);
  }

  return { root, repoPath, stateRoot };
};

const listWorkingFiles = async (repoPath: string) => {
  const paths: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) paths.push(relative(repoPath, absolute));
    }
  };
  await visit(repoPath);
  return Promise.all(
    paths.sort().map(async (path) => ({
      path,
      sha256: hash(await readFile(join(repoPath, path))),
    })),
  );
};

const captureOracle = async (repoPath: string) => {
  const status = await checkedGit(repoPath, ["status", "--porcelain=v1", "-z"]);
  const tree = await runGit(repoPath, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const message = await runGit(repoPath, ["log", "-1", "--format=%B"]);
  const indexEntries = await checkedGit(repoPath, ["ls-files", "--stage", "-z"]);
  const fsck = await runGit(repoPath, ["fsck", "--strict"]);
  const state: RepositoryOracleState = {
    statusPorcelainV1: status,
    clean: status.length === 0,
    headTree: tree.exitCode === 0 ? tree.stdout.trim() : null,
    headMessage: message.exitCode === 0 ? message.stdout : null,
    indexEntries,
    files: await listWorkingFiles(repoPath),
  };
  return {
    state,
    stateHash: hash(JSON.stringify(state)),
    valid: fsck.exitCode === 0,
  };
};

const rawInspect = async (repoPath: string): Promise<MeasuredOutcome> => {
  const startedAt = performance.now();
  const status = await runGit(repoPath, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
  ]);
  const stash = await runGit(repoPath, ["rev-list", "--walk-reflogs", "--count", "refs/stash"]);
  return {
    durationMs: performance.now() - startedAt,
    gitSubprocesses: 2,
    agentFacingOperations: 2,
    success: status.exitCode === 0 && (stash.exitCode === 0 || stash.exitCode === 128),
    outcome: status.exitCode === 0 ? "inspected" : `git-exit-${status.exitCode}`,
  };
};

const semanticInspect = async (repoPath: string): Promise<MeasuredOutcome> => {
  const startedAt = performance.now();
  try {
    const measured = await withGitMetrics(() => inspect({ repoPath }));
    return {
      durationMs: performance.now() - startedAt,
      gitSubprocesses: measured.gitSubprocessCount,
      agentFacingOperations: 1,
      success: true,
      outcome: `changes-${measured.result.changes.length}`,
    };
  } catch (error) {
    return {
      durationMs: performance.now() - startedAt,
      gitSubprocesses: 0,
      agentFacingOperations: 1,
      success: false,
      outcome: error instanceof Error ? error.name : "unknown-error",
    };
  }
};

const rawPublish = async (repoPath: string): Promise<MeasuredOutcome> => {
  const startedAt = performance.now();
  const status = await runGit(repoPath, ["status", "--porcelain=v2", "-z", "--branch"]);
  const diff = await runGit(repoPath, ["diff", "--", "selected.txt"]);
  const head = await runGit(repoPath, ["rev-parse", "--verify", "HEAD"]);
  const commit = await runGit(repoPath, [
    "commit",
    "--only",
    "--no-status",
    "-m",
    "benchmark scoped publish",
    "--",
    "selected.txt",
  ]);
  const finalStatus = await runGit(repoPath, ["status", "--porcelain=v1", "-z"]);
  return {
    durationMs: performance.now() - startedAt,
    gitSubprocesses: 5,
    agentFacingOperations: 5,
    success:
      status.exitCode === 0 &&
      diff.exitCode === 0 &&
      head.exitCode === 0 &&
      commit.exitCode === 0 &&
      finalStatus.exitCode === 0,
    outcome: commit.exitCode === 0 ? "published" : `git-exit-${commit.exitCode}`,
  };
};

const semanticPublish = async (
  repoPath: string,
  stateRoot: string,
  requestId: string,
): Promise<MeasuredOutcome> => {
  const startedAt = performance.now();
  let gitSubprocesses = 0;
  try {
    const inspected = await withGitMetrics(() => inspect({ repoPath }));
    gitSubprocesses += inspected.gitSubprocessCount;
    const snapshot: InspectResult = inspected.result;
    const selected = snapshot.changes.find(({ path }) => path === "selected.txt");
    if (!selected) throw new Error("selected fixture change missing from inspect result");
    const published = await withGitMetrics(() =>
      publish(
        {
          repoPath,
          files: ["selected.txt"],
          message: "benchmark scoped publish",
          requestId,
          expectedHead: snapshot.head,
          expectedFingerprints: { "selected.txt": selected.fingerprint },
        },
        { stateRoot },
      ),
    );
    gitSubprocesses += published.gitSubprocessCount;
    return {
      durationMs: performance.now() - startedAt,
      gitSubprocesses,
      agentFacingOperations: 2,
      success: true,
      outcome: "published",
    };
  } catch (error) {
    return {
      durationMs: performance.now() - startedAt,
      gitSubprocesses,
      agentFacingOperations: 2,
      success: false,
      outcome: error instanceof Error ? error.name : "unknown-error",
    };
  }
};

const runMethod = async (
  client: string,
  method: BenchmarkMethod,
  scenario: BenchmarkScenario,
  fixture: Fixture,
  requestId: string,
  clientProcessRunner?: BenchmarkClientProcessRunner,
) => {
  if ((benchmarkClientIds as readonly string[]).includes(client)) {
    const semantic = method === "semantic";
    const task = scenario === "inspect-dirty"
      ? semantic
        ? [
            "This isolated benchmark session is entirely a Git inspection task.",
            "Use the configured usable-git MCP inspect tool exactly once on the current repository.",
            "Do not execute shell commands and do not modify repository state.",
          ].join(" ")
        : [
            "This isolated benchmark session is entirely a raw Git inspection task.",
            "Do not use MCP or semantic repository tools.",
            "Run git status --porcelain=v2 -z --branch --untracked-files=all and",
            "git rev-list --walk-reflogs --count refs/stash as separate tool operations.",
            "Do not modify repository state.",
          ].join(" ")
      : semantic
        ? [
            "This isolated benchmark session is entirely a scoped Git publish task.",
            "Use the configured usable-git MCP inspect tool, then its publish tool.",
            "Publish only selected.txt with message 'benchmark scoped publish'.",
            "Pass the observed HEAD and selected.txt fingerprint as publish guards.",
            "Do not execute shell commands and do not touch unrelated paths.",
          ].join(" ")
        : [
            "This isolated benchmark session is entirely a raw scoped Git publish task.",
            "Do not use MCP or semantic repository tools.",
            "Inspect status, diff selected.txt, and HEAD using separate Git tool operations.",
            "Then run git commit --only --no-status -m 'benchmark scoped publish' -- selected.txt",
            "and inspect final status. Do not touch unrelated paths.",
          ].join(" ");
    const session = await runBenchmarkClientSession({
      client: client as BenchmarkClientId,
      repoPath: fixture.repoPath,
      prompt: task,
      artifactPath: join(fixture.root, `${client}-${method}-export.json`),
      mutating: scenario === "publish-scoped",
      expectedMethod: method,
      expectedSemanticOperations: semantic
        ? scenario === "inspect-dirty"
          ? ["inspect"]
          : ["inspect", "publish"]
        : [],
      expectedRawGitToolCalls: scenario === "inspect-dirty" ? 2 : 5,
      ...(clientProcessRunner ? { processRunner: clientProcessRunner } : {}),
    });
    return {
      durationMs: session.durationMs,
      gitSubprocesses: session.gitSubprocesses.value,
      agentFacingOperations: session.agentFacingOperations,
      success: session.success,
      outcome: session.outcome,
      execution: "real-client-session" as const,
      semanticAdopted: session.semanticAdopted,
      semanticToolCalls: session.semanticToolCalls,
      rawGitToolCalls: session.rawGitToolCalls,
      evidenceErrors: session.evidenceErrors,
      gitRelatedTokens: session.gitRelatedTokens,
    };
  }
  if (scenario === "inspect-dirty") {
    return method === "raw-git"
      ? rawInspect(fixture.repoPath)
      : semanticInspect(fixture.repoPath);
  }
  return method === "raw-git"
    ? rawPublish(fixture.repoPath)
    : semanticPublish(fixture.repoPath, fixture.stateRoot, requestId);
};

const runPair = async (
  client: string,
  scenario: BenchmarkScenario,
  trial: number,
  seed: number,
  clientProcessRunner?: BenchmarkClientProcessRunner,
): Promise<BenchmarkTrial[]> => {
  const pairId = `${client}-${scenario}-${trial}-${seed}`;
  const fixtures = {
    "raw-git": await createFixture(scenario, seed),
    semantic: await createFixture(scenario, seed),
  } satisfies Record<BenchmarkMethod, Fixture>;
  try {
    const initial = {
      "raw-git": await captureOracle(fixtures["raw-git"].repoPath),
      semantic: await captureOracle(fixtures.semantic.repoPath),
    };
    if (initial["raw-git"].stateHash !== initial.semantic.stateHash) {
      throw new Error(`paired fixture mismatch for ${pairId}`);
    }

    const order: BenchmarkMethod[] = trial % 2 === 0
      ? ["semantic", "raw-git"]
      : ["raw-git", "semantic"];
    const measured = {} as Record<BenchmarkMethod, MeasuredOutcome>;
    for (const method of order) {
      measured[method] = await runMethod(
        client,
        method,
        scenario,
        fixtures[method],
        `bench-${hash(pairId).slice(0, 24)}`,
        clientProcessRunner,
      );
    }

    const final = {
      "raw-git": await captureOracle(fixtures["raw-git"].repoPath),
      semantic: await captureOracle(fixtures.semantic.repoPath),
    };
    const equivalent = final["raw-git"].stateHash === final.semantic.stateHash;
    const expectedStatePreserved = scenario === "inspect-dirty"
      ? final["raw-git"].stateHash === initial["raw-git"].stateHash &&
        final.semantic.stateHash === initial.semantic.stateHash
      : final["raw-git"].state.statusPorcelainV1.includes("unrelated.txt") &&
        final.semantic.state.statusPorcelainV1.includes("unrelated.txt");

    return (["raw-git", "semantic"] as const).map((method) => ({
      pairId,
      client,
      scenario,
      method,
      trial,
      seed,
      ...measured[method],
      execution: measured[method].execution ?? "core-fixture",
      semanticAdopted: measured[method].semanticAdopted ?? null,
      semanticToolCalls: measured[method].semanticToolCalls ?? null,
      rawGitToolCalls: measured[method].rawGitToolCalls ?? null,
      evidenceErrors: measured[method].evidenceErrors ?? [],
      initialStateHash: initial[method].stateHash,
      finalStateHash: final[method].stateHash,
      finalClean: final[method].state.clean,
      gitRelatedTokens: measured[method].gitRelatedTokens ?? {
        value: null,
        source: "unavailable",
        scope: "unavailable",
        inputTokens: null,
        outputTokens: null,
      },
      oracle: {
        valid: final[method].valid,
        equivalent,
        expectedStatePreserved,
        fsck: final[method].valid ? "pass" : "fail",
      },
    }));
  } finally {
    await Promise.all(Object.values(fixtures).map(({ root }) => rm(root, { recursive: true, force: true })));
  }
};

const summarize = (trials: BenchmarkTrial[], seed: number): BenchmarkSummary[] => {
  const keys = new Map<string, BenchmarkTrial[]>();
  for (const trial of trials) {
    const key = `${trial.client}\u0000${trial.scenario}\u0000${trial.method}`;
    keys.set(key, [...(keys.get(key) ?? []), trial]);
  }
  return [...keys.values()].map((group, index) => {
    const first = group[0] as BenchmarkTrial;
    const tokenValues = group.flatMap(({ gitRelatedTokens }) =>
      gitRelatedTokens.value === null ? [] : [gitRelatedTokens.value]
    );
    const subprocessValues = group.flatMap(({ gitSubprocesses }) =>
      gitSubprocesses === null ? [] : [gitSubprocesses]
    );
    const summarySeed = seed + index * 7_919;
    return {
      client: first.client,
      scenario: first.scenario,
      method: first.method,
      trials: group.length,
      successRate: group.filter(({ success }) => success).length / group.length,
      oraclePassRate:
        group.filter(({ oracle }) => oracle.valid && oracle.equivalent && oracle.expectedStatePreserved)
          .length / group.length,
      finalCleanRate: group.filter(({ finalClean }) => finalClean).length / group.length,
      realClientSessionRate:
        group.filter(({ execution }) => execution === "real-client-session").length / group.length,
      semanticAdoptionRate: first.method === "semantic" &&
          group.some(({ execution }) => execution === "real-client-session")
        ? group.filter(({ semanticAdopted }) => semanticAdopted === true).length / group.length
        : null,
      durationMs: summarizeMetric(group.map(({ durationMs }) => durationMs), summarySeed),
      gitSubprocesses: subprocessValues.length === group.length
        ? summarizeMetric(subprocessValues, summarySeed + 1)
        : null,
      agentFacingOperations: summarizeMetric(
        group.map(({ agentFacingOperations }) => agentFacingOperations),
        summarySeed + 2,
      ),
      gitRelatedTokens: tokenValues.length === group.length
        ? summarizeMetric(tokenValues, summarySeed + 3)
        : null,
    };
  });
};

const commandOutput = async (args: string[]) => {
  const result = await runGit(process.cwd(), args);
  return result.exitCode === 0 ? result.stdout.trim() : "unavailable";
};

const evaluateReleaseGate = (
  summaries: BenchmarkSummary[],
  trialsPerScenarioClient: number,
  clients: string[],
  clientVersions: Record<string, string | null>,
) => {
  const reasons: string[] = [];
  if (benchmarkClientIds.some((client) => !clients.includes(client))) {
    reasons.push("client matrix must include codex, claude-code, cursor, and devin");
  }
  if (benchmarkClientIds.some((client) => clientVersions[client] == null)) {
    reasons.push("one or more required client versions are unavailable");
  }
  if (trialsPerScenarioClient < 30) reasons.push("fewer than 30 trials per scenario/client");
  if (summaries.some(({ successRate, oraclePassRate }) => successRate !== 1 || oraclePassRate !== 1)) {
    reasons.push("repository correctness or success rate below 100%");
  }
  if (summaries.some(({ gitRelatedTokens }) => gitRelatedTokens === null)) {
    reasons.push("Git-related client token measurements unavailable");
  }
  if (summaries.some(({ gitSubprocesses }) => gitSubprocesses === null)) {
    reasons.push("Git subprocess measurements unavailable");
  }
  if (summaries.some(({ realClientSessionRate }) => realClientSessionRate !== 1)) {
    reasons.push("benchmark did not execute real client sessions");
  }
  if (summaries.some(({ method, semanticAdoptionRate }) =>
    method === "semantic" && semanticAdoptionRate !== null && semanticAdoptionRate < 0.95
  )) {
    reasons.push("semantic-tool adoption below 95%");
  }

  const groups = new Map<string, Partial<Record<BenchmarkMethod, BenchmarkSummary>>>();
  for (const summary of summaries) {
    const key = `${summary.client}\u0000${summary.scenario}`;
    groups.set(key, { ...(groups.get(key) ?? {}), [summary.method]: summary });
  }
  for (const [key, pair] of groups) {
    const raw = pair["raw-git"];
    const semantic = pair.semantic;
    if (!raw || !semantic) {
      reasons.push(`${key}: incomplete raw/semantic pair`);
      continue;
    }
    const operationReduction = 1 - semantic.agentFacingOperations.median / raw.agentFacingOperations.median;
    if (operationReduction < 0.5) reasons.push(`${key}: agent-facing operation reduction below 50%`);
    const p95Reduction = 1 - semantic.durationMs.p95 / raw.durationMs.p95;
    if (p95Reduction < 0.3) reasons.push(`${key}: p95 duration reduction below 30%`);
    if (raw.gitRelatedTokens && semantic.gitRelatedTokens) {
      const tokenReduction = 1 - semantic.gitRelatedTokens.median / raw.gitRelatedTokens.median;
      if (tokenReduction < 0.3) reasons.push(`${key}: Git-related token reduction below 30%`);
    }
  }
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)] };
};

export const runBenchmarkMatrix = async (
  options: BenchmarkMatrixOptions,
): Promise<BenchmarkArtifact> => {
  const scenarios = options.scenarios ?? [...benchmarkScenarios];
  if (!options.allowShortRun && options.trials < 30) {
    throw new Error("release benchmark requires at least 30 trials per scenario and client");
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error("trials must be a positive integer");
  }
  if (options.clients.length === 0 || new Set(options.clients).size !== options.clients.length) {
    throw new Error("clients must be a non-empty unique list");
  }

  const trials: BenchmarkTrial[] = [];
  for (const client of options.clients) {
    for (const scenario of scenarios) {
      for (let trial = 0; trial < options.trials; trial += 1) {
        trials.push(...await runPair(
          client,
          scenario,
          trial,
          options.seed + trial,
          options.clientProcessRunner,
        ));
      }
    }
  }
  const summary = summarize(trials, options.seed);
  const clientVersions = Object.fromEntries(
    options.clients.map((client) => [client, options.clientVersions?.[client] ?? null]),
  );
  const cpu = cpus();
  return {
    schemaVersion: "usable-git-benchmark-v1",
    generatedAt: new Date().toISOString(),
    environment: {
      os: { platform: platform(), release: release(), arch: arch() },
      hardware: {
        cpuModel: cpu[0]?.model ?? "unknown",
        logicalCpus: cpu.length,
        totalMemoryBytes: totalmem(),
      },
      bunVersion: Bun.version,
      gitVersion: await commandOutput(["--version"]),
      commitSha: await commandOutput(["rev-parse", "HEAD"]),
      clientVersions,
    },
    configuration: {
      seed: options.seed,
      trialsPerScenarioClient: options.trials,
      scenarios,
      clients: options.clients,
      minimumReleaseTrials: 30,
    },
    trials,
    summary,
    releaseGate: evaluateReleaseGate(summary, options.trials, options.clients, clientVersions),
  };
};
