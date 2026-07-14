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
    const success = {
      version: "v1",
      ok: true,
      operation: "inspect",
      requestId: "request-1",
      repository: {
        requestedPath: "/repo",
        root: "/repo",
        head: { kind: "oid", oid: "a".repeat(40) },
        branch: "main",
      },
      backend: "git-cli",
      transport: "mcp",
      durationMs: 1,
      gitSubprocessCount: 1,
      warnings: [],
      result: {},
    } as const;
    expect(JSON.parse(JSON.stringify(v1EnvelopeSchema.parse(success)))).toEqual(
      JSON.parse(JSON.stringify(success)),
    );
    expect(() =>
      v1EnvelopeSchema.parse({
        ...success,
        error: { code: "GIT_FAILED", message: "must not coexist" },
      }),
    ).toThrow();
  });

  test("requires the typed error branch to agree with ok", () => {
    const failure = {
      version: "v1",
      ok: false,
      operation: "publish",
      requestId: "request-2",
      repository: {
        requestedPath: "/repo",
        root: null,
        head: { kind: "unknown" },
        branch: null,
      },
      backend: "git-cli",
      transport: "cli",
      durationMs: 1,
      gitSubprocessCount: 0,
      warnings: [],
      error: { code: "INVALID_REPOSITORY", message: "not a repository" },
    } as const;
    expect(JSON.parse(JSON.stringify(v1EnvelopeSchema.parse(failure)))).toEqual(
      JSON.parse(JSON.stringify(failure)),
    );
    expect(() => v1EnvelopeSchema.parse({ ...failure, ok: true })).toThrow();
  });
});
