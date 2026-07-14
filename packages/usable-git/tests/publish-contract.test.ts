import { describe, expect, test } from "bun:test";
import { publishRequestSchema } from "../src/contracts/v1/publish.ts";

describe("publish contract", () => {
  test("accepts an exact publish request", () => {
    const request = publishRequestSchema.parse({
      repoPath: "/tmp/repository",
      files: ["nested/file.txt"],
      message: "message",
      requestId: "request-1",
      expectedHead: { kind: "unborn" },
      expectedFingerprints: { "nested/file.txt": "a".repeat(64) },
    });

    expect(request.files).toEqual(["nested/file.txt"]);
  });

  test("requires unique literal files and a fingerprint for every path", () => {
    const base = {
      repoPath: "/tmp/repository",
      message: "message",
      requestId: "request-1",
      expectedHead: { kind: "unborn" as const },
    };

    for (const value of [
      {
        ...base,
        files: ["file.txt", "file.txt"],
        expectedFingerprints: { "file.txt": "a".repeat(64) },
      },
      { ...base, files: ["file.txt"], expectedFingerprints: {} },
      {
        ...base,
        files: ["."],
        expectedFingerprints: { ".": "a".repeat(64) },
      },
      {
        ...base,
        files: ["../file.txt"],
        expectedFingerprints: { "../file.txt": "a".repeat(64) },
      },
      {
        ...base,
        files: ["*.txt"],
        expectedFingerprints: { "*.txt": "a".repeat(64) },
      },
    ]) {
      expect(() => publishRequestSchema.parse(value)).toThrow();
    }
  });
});
