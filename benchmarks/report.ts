import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkArtifact, BenchmarkSummary } from "./runner.ts";

const formatNumber = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);
const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
const formatMetric = (summary: BenchmarkSummary["durationMs"]) =>
  `${formatNumber(summary.median)} [95% CI ${formatNumber(summary.medianCi.low)}–${formatNumber(summary.medianCi.high)}]`;

const timestampSlug = (generatedAt: string) =>
  generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export const renderBenchmarkMarkdown = (
  artifact: BenchmarkArtifact,
  rawJsonFileName: string,
) => {
  const gate = artifact.releaseGate.pass ? "RELEASE-ELIGIBLE" : "NOT RELEASE-ELIGIBLE";
  const rows = artifact.summary.map((summary) =>
    `| ${summary.client} | ${summary.scenario} | ${summary.method} | ${summary.trials} | ${formatPercent(summary.successRate)} | ${formatPercent(summary.oraclePassRate)} | ${formatPercent(summary.realClientSessionRate)} | ${summary.semanticAdoptionRate === null ? "n/a" : formatPercent(summary.semanticAdoptionRate)} | ${formatMetric(summary.durationMs)} | ${formatNumber(summary.durationMs.p95)} [${formatNumber(summary.durationMs.p95Ci.low)}–${formatNumber(summary.durationMs.p95Ci.high)}] | ${summary.gitSubprocesses ? formatNumber(summary.gitSubprocesses.median) : "unavailable"} | ${formatNumber(summary.agentFacingOperations.median)} | ${summary.gitRelatedTokens ? formatNumber(summary.gitRelatedTokens.median) : "unavailable"} |`
  );
  const reasons = artifact.releaseGate.reasons.length === 0
    ? ["- All benchmark-specific release gates passed."]
    : artifact.releaseGate.reasons.map((reason) => `- ${reason}`);
  const clientVersions = Object.entries(artifact.environment.clientVersions)
    .map(([client, version]) => `- ${client}: ${version ?? "unavailable"}`);

  return `# usable-git benchmark report

Status: **${gate}**

Generated: ${artifact.generatedAt}
Commit: \`${artifact.environment.commitSha}\`
Seed: \`${artifact.configuration.seed}\`
Trials per scenario/client: ${artifact.configuration.trialsPerScenarioClient}
Raw trial artifact: [${rawJsonFileName}](./${rawJsonFileName})

## Environment

- OS: ${artifact.environment.os.platform} ${artifact.environment.os.release} (${artifact.environment.os.arch})
- CPU: ${artifact.environment.hardware.cpuModel} × ${artifact.environment.hardware.logicalCpus}
- Memory: ${artifact.environment.hardware.totalMemoryBytes} bytes
- Bun: ${artifact.environment.bunVersion}
- Git: ${artifact.environment.gitVersion}

Client versions:

${clientVersions.join("\n")}

## Results

| Client | Scenario | Method | Trials | Success | Oracle | Real sessions | Semantic adoption | Median ms (95% CI) | P95 ms (95% CI) | Git subprocesses | Agent operations | Git tokens |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.join("\n")}

## Release gate

${reasons.join("\n")}

Token values marked unavailable were not measured or estimated. No performance claim may use them. Short runs are fixture checks only; v1 requires at least 40 trials per scenario and client.
`;
};

export const writeBenchmarkArtifact = async (
  artifact: BenchmarkArtifact,
  outputDirectory: string,
) => {
  await mkdir(outputDirectory, { recursive: true });
  const baseName = `usable-git-benchmark-${timestampSlug(artifact.generatedAt)}`;
  const jsonFileName = `${baseName}.json`;
  const markdownFileName = `${baseName}.md`;
  const jsonPath = join(outputDirectory, jsonFileName);
  const markdownPath = join(outputDirectory, markdownFileName);
  await Bun.write(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
  await Bun.write(markdownPath, renderBenchmarkMarkdown(artifact, jsonFileName));
  return { jsonPath, markdownPath };
};
