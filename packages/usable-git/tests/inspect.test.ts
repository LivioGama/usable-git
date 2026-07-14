import { afterEach, describe, expect, test } from "bun:test";
import { inspect } from "../src/operations/inspect.ts";
import {
  commitFile,
  createRepository,
  type TestRepository,
  writeFile,
} from "./helpers/repository.ts";

const repositories: TestRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map(({ cleanup }) => cleanup())));

const repository = async () => {
  const created = await createRepository();
  repositories.push(created);
  return created;
};

describe("inspect", () => {
  test("reports branch state and fingerprints staged, unstaged, and untracked changes", async () => {
    const repo = await repository();
    await commitFile(repo, "tracked.txt", "base\n", "initial");
    await writeFile(repo, "tracked.txt", "staged\n");
    await repo.run("add", "--", "tracked.txt");
    await writeFile(repo, "tracked.txt", "unstaged\n");
    await writeFile(repo, "new\nfile.txt", "untracked\n");

    const result = await inspect({ repoPath: repo.path });
    expect(result.branch.head).not.toBeNull();
    expect(result.staged).toEqual(["tracked.txt"]);
    expect(result.unstaged).toEqual(["tracked.txt"]);
    expect(result.untracked).toEqual(["new\nfile.txt"]);
    expect(result.changes.every(({ fingerprint }) => /^[a-f0-9]{64}$/.test(fingerprint))).toBe(
      true,
    );
  });

  test("changes a fingerprint when worktree contents change", async () => {
    const repo = await repository();
    await writeFile(repo, "file.txt", "one");
    const before = await inspect({ repoPath: repo.path });
    await writeFile(repo, "file.txt", "two");
    const after = await inspect({ repoPath: repo.path });
    expect(after.changes[0]?.fingerprint).not.toBe(before.changes[0]?.fingerprint);
  });
});
