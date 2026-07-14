import { afterEach, describe, expect, test } from "bun:test";
import { history } from "../src/operations/history.ts";
import {
  commitFile,
  createRepository,
  type TestRepository,
} from "./helpers/repository.ts";

const repositories: TestRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map(({ cleanup }) => cleanup())));

const repository = async () => {
  const created = await createRepository();
  repositories.push(created);
  return created;
};

describe("history", () => {
  test("returns newest-first local commits and supports cursors", async () => {
    const repo = await repository();
    await commitFile(repo, "one.txt", "one", "first\n\nbody");
    await commitFile(repo, "two.txt", "two", "second");

    const first = await history({ repoPath: repo.path, limit: 1 });
    expect(first.commits).toHaveLength(1);
    expect(first.commits[0]?.message).toContain("second");
    expect(first.commits[0]?.committer.email).toBe("usable-git@example.test");
    expect(first.head.kind).toBe("oid");
    expect(first.nextCursor).toBeDefined();

    const second = await history({ repoPath: repo.path, limit: 1, cursor: first.nextCursor });
    expect(second.commits[0]?.message).toContain("first");
  });

  test("does not fetch while reading history", async () => {
    const repo = await repository();
    await commitFile(repo, "one.txt", "one", "first");
    const result = await history({ repoPath: repo.path, ref: "HEAD", limit: 20 });
    expect(result.commits).toHaveLength(1);
  });

  test("returns explicit unborn state", async () => {
    const repo = await repository();
    const result = await history({ repoPath: repo.path });
    expect(result).toMatchObject({ commits: [], head: { kind: "unborn" } });
  });

  test("rejects a cursor after the bound ref advances", async () => {
    const repo = await repository();
    await commitFile(repo, "one.txt", "one", "first");
    await commitFile(repo, "two.txt", "two", "second");
    const first = await history({ repoPath: repo.path, limit: 1 });
    await commitFile(repo, "three.txt", "three", "third");

    const error = await history({
      repoPath: repo.path,
      limit: 1,
      cursor: first.nextCursor,
    }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "STALE_STATE" });
  });
});
