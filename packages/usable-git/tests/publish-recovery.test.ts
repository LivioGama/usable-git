import { describe, expect, test } from "bun:test";
import { createPublishRecoveryStore } from "../src/mutations/publish-recovery.ts";
import { withTempDirectory } from "./support/temp.ts";

describe("publish recovery state", () => {
  test("durably round-trips and removes mutation ownership metadata", async () =>
    withTempDirectory("usable-git-recovery-", async (stateRoot) => {
      const store = createPublishRecoveryStore({ stateRoot });
      const state = {
        schemaVersion: 1 as const,
        requestId: "request-1",
        repoKey: "repo",
        inputHash: "input",
        phase: "index_staged" as const,
        preHead: "a".repeat(40),
        files: ["file.txt"],
        index: {
          exists: true as const,
          checksum: "b".repeat(64),
          bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
          mode: 0o644,
        },
        ownedIndexChecksum: "c".repeat(64),
      };

      await store.write(state);
      expect(await store.read("request-1")).toEqual(state);
      await store.remove("request-1");
      expect(await store.read("request-1")).toBeNull();
    }));
});
