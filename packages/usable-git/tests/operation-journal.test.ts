import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  IdempotencyConflictError,
  createOperationJournal,
} from "@usable-git/mutations/operation-journal";
import { withTempDirectory } from "./support/temp";

describe("operation journal", () => {
  test("persists phases and replays a terminal result for the same request", async () => {
    await withTempDirectory("usable-git-journal-", async (directory) => {
      const journal = createOperationJournal({
        stateRoot: join(directory, "state"),
      });
      const started = await journal.begin({
        requestId: "request-1",
        operation: "publish",
        repoKey: "repo-a",
        inputHash: "input-a",
      });

      expect(started.kind).toBe("started");
      await journal.transition("request-1", "index_staged");
      await journal.complete("request-1", { commitOid: "abc123" });

      const replay = await journal.begin({
        requestId: "request-1",
        operation: "publish",
        repoKey: "repo-a",
        inputHash: "input-a",
      });

      expect(replay).toEqual({
        kind: "replay",
        result: { commitOid: "abc123" },
      });
    });
  });

  test("rejects request ID reuse with different canonical input", async () => {
    await withTempDirectory("usable-git-journal-conflict-", async (directory) => {
      const journal = createOperationJournal({
        stateRoot: join(directory, "state"),
      });
      await journal.begin({
        requestId: "request-2",
        operation: "push",
        repoKey: "repo-a",
        inputHash: "input-a",
      });

      await expect(
        journal.begin({
          requestId: "request-2",
          operation: "push",
          repoKey: "repo-a",
          inputHash: "input-b",
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });
  });

  test("creates a request atomically under concurrent begin calls", async () => {
    await withTempDirectory("usable-git-journal-race-", async (directory) => {
      const journal = createOperationJournal({ stateRoot: join(directory, "state") });
      const input = {
        requestId: "request-race",
        operation: "publish" as const,
        repoKey: "repo-a",
        inputHash: "input-a",
      };
      const outcomes = await Promise.all([journal.begin(input), journal.begin(input)]);
      expect(outcomes.map(({ kind }) => kind).sort()).toEqual(["resume", "started"]);
      expect(await journal.read(input.requestId)).toMatchObject({
        requestId: input.requestId,
        phase: "started",
      });
    });
  });
});
