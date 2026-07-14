import { inspectRequestSchema, type InspectRequest } from "../contracts/v1.ts";
import { fingerprintChange } from "../git/fingerprint.ts";
import { validateLiteralFiles } from "../git/paths.ts";
import { requireWorktreeRepository } from "../git/repository.ts";
import { git } from "../git/runner.ts";
import { parsePorcelainV2, type StatusChange } from "../git/status.ts";

export type InspectedChange = StatusChange & { fingerprint: string };

export type InspectResult = {
  repository: {
    root: string;
    gitDir: string;
    commonDir: string;
  };
  branch: ReturnType<typeof parsePorcelainV2>["branch"];
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  changes: InspectedChange[];
};

const hasIndexChange = ({ indexStatus, conflicted }: StatusChange) =>
  !conflicted && ![".", " ", "?", "!"].includes(indexStatus);

const hasWorktreeChange = ({ worktreeStatus, conflicted }: StatusChange) =>
  !conflicted && ![".", " ", "?", "!"].includes(worktreeStatus);

export const inspect = async (input: InspectRequest): Promise<InspectResult> => {
  const request = inspectRequestSchema.parse(input);
  const repository = await requireWorktreeRepository(request.repoPath);
  const files = request.files
    ? await validateLiteralFiles(repository.root, request.files)
    : undefined;
  const args = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];
  if (files) args.push("--", ...files);
  const statusResult = await git.runChecked(repository.root, args);
  const parsed = parsePorcelainV2(statusResult.stdout);
  const changes = await Promise.all(
    parsed.changes
      .filter(({ kind }) => kind !== "ignored")
      .map(async (change) => ({
        ...change,
        fingerprint: await fingerprintChange(repository.root, change),
      })),
  );

  return {
    repository: {
      root: repository.root,
      gitDir: repository.gitDir,
      commonDir: repository.commonDir,
    },
    branch: parsed.branch,
    staged: changes.filter(hasIndexChange).map(({ path }) => path),
    unstaged: changes.filter(hasWorktreeChange).map(({ path }) => path),
    untracked: changes.filter(({ kind }) => kind === "untracked").map(({ path }) => path),
    conflicted: changes.filter(({ conflicted }) => conflicted).map(({ path }) => path),
    changes,
  };
};
