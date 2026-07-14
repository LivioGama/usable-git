#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  generateHomebrewFormula,
  writeHomebrewFormula,
  type HomebrewRelease,
} from "./generate-formula.ts";

export type HomebrewCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type HomebrewCommandRunner = (
  command: string,
  args: string[],
) => Promise<HomebrewCommandResult>;

type PrepareHomebrewReleaseOptions = HomebrewRelease & {
  tapRoot: string;
  formulaRef: string;
  fetchArtifact?: (url: string) => Promise<Response>;
  runner?: HomebrewCommandRunner;
};

export class HomebrewReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewReleaseError";
  }
}

const bounded = (value: string) => value.slice(0, 65_536);

export const createHomebrewCommandRunner = (
  timeoutMs = 15 * 60 * 1_000,
): HomebrewCommandRunner => async (command, args) => {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  const processHandle = Bun.spawn([command, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    processHandle.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    return {
      exitCode: timedOut ? 124 : exitCode,
      stdout: bounded(stdout),
      stderr: timedOut
        ? `Homebrew command timed out after ${timeoutMs}ms\n${bounded(stderr)}`
        : bounded(stderr),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const artifactDigest = async (
  url: string,
  fetchArtifact: (url: string) => Promise<Response>,
) => {
  const response = await fetchArtifact(url);
  if (!response.ok || !response.body) {
    throw new HomebrewReleaseError(
      `artifact download failed with HTTP ${response.status}`,
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
};

const readPriorFormula = async (path: string) => {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const atomicRestore = async (path: string, bytes: Uint8Array | null) => {
  if (!bytes) {
    await rm(path, { force: true });
    return;
  }
  const temporaryPath = `${path}.${randomUUID()}.restore`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o644 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const assertLocation = (tapRoot: string, formulaRef: string) => {
  if (!isAbsolute(tapRoot)) throw new HomebrewReleaseError("tapRoot must be absolute");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/usable-git$/.test(formulaRef)) {
    throw new HomebrewReleaseError(
      "formulaRef must be a fully-qualified owner/tap/usable-git name",
    );
  }
};

export const prepareHomebrewRelease = async ({
  tapRoot,
  formulaRef,
  fetchArtifact = fetch,
  runner = createHomebrewCommandRunner(),
  ...release
}: PrepareHomebrewReleaseOptions) => {
  assertLocation(tapRoot, formulaRef);
  generateHomebrewFormula(release);
  const observedSha256 = await artifactDigest(release.url, fetchArtifact);
  if (observedSha256 !== release.sha256) {
    throw new HomebrewReleaseError(
      `artifact SHA-256 mismatch: expected ${release.sha256}, observed ${observedSha256}`,
    );
  }

  const formulaPath = join(tapRoot, "Formula", "usable-git.rb");
  const priorFormula = await readPriorFormula(formulaPath);
  await writeHomebrewFormula({ ...release, outputPath: formulaPath });
  const commands: Array<[string, string[]]> = [
    ["brew", ["audit", "--strict", "--formula", formulaRef]],
    ["brew", ["install", "--build-from-source", formulaRef]],
    ["brew", ["test", formulaRef]],
  ];

  try {
    for (const [command, args] of commands) {
      const result = await runner(command, args);
      if (result.exitCode !== 0) {
        throw new HomebrewReleaseError(
          `${command} ${args.join(" ")} failed with exit ${result.exitCode}: ${result.stderr}`,
        );
      }
    }
  } catch (error) {
    await atomicRestore(formulaPath, priorFormula);
    throw error;
  }

  return {
    formulaPath,
    artifactSha256: observedSha256,
    verifiedCommands: commands.length,
  };
};

const requiredFlag = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new HomebrewReleaseError(`${flag} is required`);
  return value;
};

export const runPrepareReleaseCli = async (args = process.argv.slice(2)) =>
  prepareHomebrewRelease({
    version: requiredFlag(args, "--version"),
    url: requiredFlag(args, "--url"),
    sha256: requiredFlag(args, "--sha256"),
    tapRoot: requiredFlag(args, "--tap-root"),
    formulaRef: requiredFlag(args, "--formula-ref"),
  });

if (import.meta.main) {
  try {
    const result = await runPrepareReleaseCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
