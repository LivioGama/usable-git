import { afterEach, describe, expect, test } from "bun:test";
import { executeOperation } from "../src/service.ts";
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

describe("semantic operation service", () => {
  test("returns a complete v1 envelope and aggregated Git process count", async () => {
    const repo = await repository();
    await commitFile(repo, "tracked.txt", "base\n", "initial");
    await writeFile(repo, "tracked.txt", "changed\n");

    const envelope = await executeOperation(
      "inspect",
      { repoPath: repo.path },
      { transport: "cli" },
    );

    expect(envelope).toMatchObject({
      version: "v1",
      ok: true,
      operation: "inspect",
      repository: { requestedPath: repo.path, root: repo.path },
      backend: "git-cli",
      transport: "cli",
      warnings: [],
    });
    expect(envelope.gitSubprocessCount).toBeGreaterThan(0);
    expect(envelope.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("converts validation failures into stable structured errors", async () => {
    const envelope = await executeOperation(
      "inspect",
      { repoPath: "relative" },
      { transport: "mcp" },
    );
    expect(envelope).toMatchObject({
      ok: false,
      operation: "inspect",
      repository: {
        requestedPath: "relative",
        root: null,
        head: { kind: "unknown" },
      },
      error: { code: "INVALID_INPUT" },
    });
  });

  test("keeps CLI and MCP operation semantics equivalent", async () => {
    const repo = await repository();
    await writeFile(repo, "new.txt", "new\n");
    const cli = await executeOperation("inspect", { repoPath: repo.path }, { transport: "cli" });
    const mcp = await executeOperation("inspect", { repoPath: repo.path }, { transport: "mcp" });
    expect(cli.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    if (!cli.ok || !mcp.ok) throw new Error("inspect unexpectedly failed");
    expect(mcp.result).toEqual(cli.result);
    expect(mcp.repository).toEqual(cli.repository);
  });

  test("preserves typed mutation error codes in the shared envelope", async () => {
    const envelope = await executeOperation(
      "publish",
      { repoPath: "/tmp/missing-required-publish-fields" },
      { transport: "cli" },
    );
    expect(envelope).toMatchObject({
      ok: false,
      operation: "publish",
      error: { code: "INVALID_INPUT" },
    });
  });
});
