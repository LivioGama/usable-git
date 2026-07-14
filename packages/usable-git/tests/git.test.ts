import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverRepository } from "../src/git/repository.ts";
import { createGitRunner } from "../src/git/runner.ts";
import { parsePorcelainV2 } from "../src/git/status.ts";
import { validateLiteralFiles } from "../src/git/paths.ts";
import { commitFile, createRepository, writeFile } from "./helpers/repository.ts";

describe("Git primitives", () => {
  test("runner uses direct argv and stable non-interactive environment", async () => {
    const repository = await createRepository();
    try {
      const calls: string[][] = [];
      const runner = createGitRunner({
        onSpawn: ({ argv }) => calls.push(argv),
      });
      const result = await runner.run(repository.path, ["status", "--porcelain=v2", "-z"]);

      expect(result.exitCode).toBe(0);
      expect(calls[0]).toContain("--no-pager");
      expect(result.processCount).toBe(1);
    } finally {
      await repository.cleanup();
    }
  });

  test("discovers the worktree and common Git directory", async () => {
    const repository = await createRepository();
    try {
      const discovered = await discoverRepository(join(repository.path, "."));
      expect(discovered.root).toBe(repository.path);
      expect(discovered.isBare).toBe(false);
      expect(discovered.commonDir).toEndWith("/.git");
    } finally {
      await repository.cleanup();
    }
  });

  test("validates literal files and preserves unusual names", async () => {
    const repository = await createRepository();
    try {
      await writeFile(repository, "line\nbreak.txt", "hello");
      expect(await validateLiteralFiles(repository.path, ["line\nbreak.txt"])).toEqual([
        "line\nbreak.txt",
      ]);
      await expect(validateLiteralFiles(repository.path, ["."])).rejects.toThrow();
      await expect(validateLiteralFiles(repository.path, ["../escape"])).rejects.toThrow();
      await expect(validateLiteralFiles(repository.path, [":(glob)*"])).rejects.toThrow();
    } finally {
      await repository.cleanup();
    }
  });

  test("parses NUL-delimited ordinary, renamed, conflicted, and untracked records", () => {
    const status = [
      "# branch.oid abc",
      "# branch.head main",
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new\nname.txt",
      "old\nname.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
      "? odd\nfile.txt",
      "",
    ].join("\0");

    const parsed = parsePorcelainV2(status);
    expect(parsed.branch.head).toBe("main");
    expect(parsed.changes.map(({ path }) => path)).toEqual([
      "staged.txt",
      "new\nname.txt",
      "conflict.txt",
      "odd\nfile.txt",
    ]);
    expect(parsed.changes[1]?.originalPath).toBe("old\nname.txt");
    expect(parsed.changes[2]?.conflicted).toBe(true);
  });
});
