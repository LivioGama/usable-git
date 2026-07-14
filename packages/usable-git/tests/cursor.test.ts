import { describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor } from "../src/contracts/cursor.ts";

describe("opaque cursor", () => {
  test("round-trips bound pagination state without exposing repository data", () => {
    const cursor = encodeCursor({
      operation: "review",
      requestDigest: "a".repeat(64),
      snapshot: "b".repeat(64),
      offset: { item: 2, character: 17 },
    });
    expect(cursor).not.toContain("review");
    expect(decodeCursor(cursor, "review")).toEqual({
      version: 1,
      operation: "review",
      requestDigest: "a".repeat(64),
      snapshot: "b".repeat(64),
      offset: { item: 2, character: 17 },
    });
  });

  test("rejects tampering and cross-operation reuse", () => {
    const cursor = encodeCursor({
      operation: "history",
      requestDigest: "a".repeat(64),
      snapshot: "b".repeat(40),
      offset: 3,
    });
    expect(() => decodeCursor(`${cursor.slice(0, -1)}x`, "history")).toThrow();
    expect(() => decodeCursor(cursor, "review")).toThrow();
  });
});
