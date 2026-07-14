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

  test("emits exactly one allowlisted telemetry event at the operation boundary", async () => {
    const repo = await repository();
    await writeFile(repo, "new.txt", "private contents\n");
    const events: unknown[] = [];
    await executeOperation("inspect", { repoPath: repo.path }, {
      transport: "cli",
      client: "codex",
      telemetrySink: {
        emit: async (event) => {
          events.push(event);
          return { written: true, repositoryHash: "a".repeat(64) };
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "inspect",
      client: "codex",
      transport: "cli",
      resultCode: "success",
      repositoryIdentity: repo.path,
    });
    expect(JSON.stringify(events[0])).not.toContain("private contents");
    expect(JSON.stringify(events[0])).not.toContain("new.txt");
  });

  test("returns a valid success envelope for the real publish path", async () => {
    const repo = await repository();
    await writeFile(repo, "selected.txt", "selected\n");
    const inspected = await executeOperation(
      "inspect",
      { repoPath: repo.path, files: ["selected.txt"] },
      { transport: "cli" },
    );
    if (!inspected.ok) throw new Error("inspect failed");
    const inspectedResult = inspected.result as {
      changes: Array<{ path: string; fingerprint: string }>;
    };
    const fingerprint = inspectedResult.changes[0]!.fingerprint;
    const envelope = await executeOperation("publish", {
      repoPath: repo.path,
      files: ["selected.txt"],
      message: "publish through service",
      requestId: `service-publish-${crypto.randomUUID()}`,
      expectedHead: { kind: "unborn" },
      expectedFingerprints: { "selected.txt": fingerprint },
    }, { transport: "cli" });
    expect(envelope).toMatchObject({
      ok: true,
      operation: "publish",
      repository: {
        root: repo.path,
        head: { kind: "oid" },
      },
      result: { committedPaths: ["selected.txt"] },
    });
  });
});
