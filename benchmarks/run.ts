#!/usr/bin/env bun
import { resolve } from "node:path";
import { writeBenchmarkArtifact } from "./report.ts";
import {
  benchmarkScenarios,
  runBenchmarkMatrix,
  type BenchmarkMatrixOptions,
  type BenchmarkScenario,
} from "./runner.ts";

const usage = `Usage: bun benchmarks/run.ts \\
  --clients codex,claude-code,devin \\
  --trials 40 --seed 20260714 [--scenarios inspect-dirty,publish-scoped] \\
  [--client-version client=version] [--output benchmarks/results]

--allow-short-run permits fixture checks below 40 trials. Their report remains non-release-eligible.
`;

const valuesFor = (args: string[], flag: string) =>
  args.flatMap((value, index) => value === flag && args[index + 1] ? [args[index + 1] as string] : []);

const oneValue = (args: string[], flag: string) => {
  const values = valuesFor(args, flag);
  if (values.length > 1) throw new Error(`${flag} may be supplied only once`);
  return values[0];
};

const parseList = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`${name} is required`);
  const entries = value.split(",").filter(Boolean);
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error(`${name} must be a non-empty unique comma-separated list`);
  }
  return entries;
};

const parsePositiveInteger = (value: string | undefined, name: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const parseVersions = (args: string[]) =>
  Object.fromEntries(valuesFor(args, "--client-version").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error("--client-version must use client=version");
    }
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));

export const parseBenchmarkArgs = (args: string[]) => {
  if (args.includes("--help") || args.includes("-h")) return { help: true as const };
  const scenarios = oneValue(args, "--scenarios")?.split(",") ?? [...benchmarkScenarios];
  const invalidScenario = scenarios.find(
    (scenario) => !(benchmarkScenarios as readonly string[]).includes(scenario),
  );
  if (invalidScenario) throw new Error(`unsupported scenario: ${invalidScenario}`);
  const options: BenchmarkMatrixOptions = {
    clients: parseList(oneValue(args, "--clients"), "--clients"),
    scenarios: scenarios as BenchmarkScenario[],
    trials: parsePositiveInteger(oneValue(args, "--trials"), "--trials"),
    seed: parsePositiveInteger(oneValue(args, "--seed"), "--seed"),
    clientVersions: parseVersions(args),
    allowShortRun: args.includes("--allow-short-run"),
  };
  return {
    help: false as const,
    options,
    outputDirectory: resolve(oneValue(args, "--output") ?? "benchmarks/results"),
  };
};

export const runBenchmarkCli = async (args = process.argv.slice(2)) => {
  let parsed: ReturnType<typeof parseBenchmarkArgs>;
  try {
    parsed = parseBenchmarkArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    return 64;
  }
  if (parsed.help) {
    console.log(usage);
    return 0;
  }

  try {
    const artifact = await runBenchmarkMatrix(parsed.options);
    const written = await writeBenchmarkArtifact(artifact, parsed.outputDirectory);
    console.log(`${artifact.releaseGate.pass ? "RELEASE-ELIGIBLE" : "NOT RELEASE-ELIGIBLE"}`);
    console.log(written.jsonPath);
    console.log(written.markdownPath);
    return artifact.releaseGate.pass ? 0 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

if (import.meta.main) process.exitCode = await runBenchmarkCli();
