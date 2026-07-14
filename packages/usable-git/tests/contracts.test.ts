import { describe, expect, test } from "bun:test";
import {
  historyRequestSchema,
  inspectRequestSchema,
  reviewRequestSchema,
  v1EnvelopeSchema,
} from "../src/contracts/v1.ts";

describe("v1 read contracts", () => {
  test("requires absolute repository paths", () => {
    expect(() => inspectRequestSchema.parse({ repoPath: "relative" })).toThrow();
    expect(
      inspectRequestSchema.parse({ repoPath: "/repo", files: ["hello.txt"] }),
    ).toEqual({ repoPath: "/repo", files: ["hello.txt"] });
  });

  test("bounds review and history requests", () => {
    expect(() => reviewRequestSchema.parse({ repoPath: "/repo", byteCap: 0 })).toThrow();
    expect(() => historyRequestSchema.parse({ repoPath: "/repo", limit: 101 })).toThrow();
    expect(historyRequestSchema.parse({ repoPath: "/repo" })).toEqual({
      repoPath: "/repo",
      ref: "HEAD",
      limit: 20,
    });
  });

  test("accepts structured successful envelopes", () => {
    expect(
      v1EnvelopeSchema.parse({
        version: "v1",
        ok: true,
        operationId: "op-1",
        backend: "git-cli",
        durationMs: 1,
        gitProcessCount: 1,
        warnings: [],
        result: {},
      }).ok,
    ).toBe(true);
  });
});
