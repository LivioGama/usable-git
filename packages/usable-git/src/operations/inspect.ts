import { inspectRequestSchema, type InspectRequest } from "../contracts/v1.ts";
import {
  inspectResultSchema,
  type InspectedChange,
  type InspectResult,
} from "../contracts/v1/inspect.ts";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fingerprintChange } from "../git/fingerprint.ts";
import { validateLiteralFiles } from "../git/paths.ts";
import { requireWorktreeRepository } from "../git/repository.ts";
import { git } from "../git/runner.ts";
import { parsePorcelainV2, type StatusChange } from "../git/status.ts";

export type { InspectedChange, InspectResult } from "../contracts/v1/inspect.ts";

const exists = async (path: string) => access(path).then(() => true, () => false);

const inspectInProgress = async (gitDir: string) => {
  const markers = [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"],
    ["bisect", "BISECT_LOG"],
    ["sequencer", "sequencer"],
  ] as const;
  const active = await Promise.all(
    markers.map(async ([name, marker]) => ({ name, active: await exists(join(gitDir, marker)) })),
  );
  return [...new Set(active.filter(({ active }) => active).map(({ name }) => name))];
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
  const stash = await git.run(repository.root, ["rev-list", "--walk-reflogs", "--count", "refs/stash"]);
  const stashCount = stash.exitCode === 0 ? Number.parseInt(stash.stdout.trim(), 10) || 0 : 0;
  const inProgress = await inspectInProgress(repository.gitDir);
  const changes = await Promise.all(
    parsed.changes
      .filter(({ kind }) => kind !== "ignored")
      .map(async (change) => ({
        ...change,
        fingerprint: await fingerprintChange(repository.root, change),
      })),
  );

  return inspectResultSchema.parse({
    repository: {
      root: repository.root,
      gitDir: repository.gitDir,
      commonDir: repository.commonDir,
    },
    branch: parsed.branch,
    head: parsed.branch.oid === null
      ? { kind: "unborn" }
      : { kind: "oid", oid: parsed.branch.oid },
    stashCount,
    inProgress,
    staged: changes.filter(hasIndexChange).map(({ path }) => path),
    unstaged: changes.filter(hasWorktreeChange).map(({ path }) => path),
    untracked: changes.filter(({ kind }) => kind === "untracked").map(({ path }) => path),
    conflicted: changes.filter(({ conflicted }) => conflicted).map(({ path }) => path),
    changes,
  });
};
