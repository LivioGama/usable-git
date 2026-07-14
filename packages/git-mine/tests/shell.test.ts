import { describe, expect, test } from "bun:test";
import { splitCommands, unwrapCommand, extractGitCommands, normalizeGitCommand } from "../src/extract/shell";

describe("splitCommands", () => {
  test("splits on &&, ;, | and ||", () => {
    expect(splitCommands("git status && git diff")).toEqual(["git status", "git diff"]);
    expect(splitCommands("git add .; git commit")).toEqual(["git add .", "git commit"]);
    expect(splitCommands("git log | grep feat")).toEqual(["git log", "grep feat"]);
  });

  test("does not split inside quotes", () => {
    expect(splitCommands("git commit -m 'feat: add stuff; fix things' && git push")).toEqual([
      "git commit -m 'feat: add stuff; fix things'",
      "git push"
    ]);
    expect(splitCommands('git commit -m "feat: add stuff && fix things"')).toEqual([
      'git commit -m "feat: add stuff && fix things"'
    ]);
  });
});

describe("unwrapCommand", () => {
  test("unwraps rtk and sudo prefixes", () => {
    expect(unwrapCommand("rtk git status")).toBe("git status");
    expect(unwrapCommand("sudo git status")).toBe("git status");
    expect(unwrapCommand("rtk sudo git status")).toBe("git status");
  });

  test("unwraps env prefixes and environment variables", () => {
    expect(unwrapCommand("env VAR=1 git diff")).toBe("git diff");
    expect(unwrapCommand("VAR=value git diff")).toBe("git diff");
    expect(unwrapCommand("VAR='quoted value' git diff")).toBe("git diff");
    expect(unwrapCommand('VAR="quoted value" git diff')).toBe("git diff");
    expect(unwrapCommand("rtk NODE_ENV=production sudo git status")).toBe("git status");
  });

  test("unwraps git -C path option", () => {
    expect(unwrapCommand("git -C /foo/bar status")).toBe("git status");
    expect(unwrapCommand("git -C '/foo space' diff")).toBe("git diff");
    expect(unwrapCommand('git -C "/foo space" log')).toBe("git log");
  });
});

describe("extractGitCommands", () => {
  test("extracts and cleans git commands from compound strings", () => {
    const extracted = extractGitCommands("cd some/dir && rtk git status && npm test && git -C foo diff");
    expect(extracted).toEqual([
      { raw: "rtk git status", clean: "git status" },
      { raw: "git -C foo diff", clean: "git diff" }
    ]);
  });
});

describe("normalizeGitCommand", () => {
  test("returns subcommand", () => {
    expect(normalizeGitCommand("git status --porcelain")).toBe("status");
    expect(normalizeGitCommand("git commit -m 'hello'")).toBe("commit");
    expect(normalizeGitCommand("git push origin main")).toBe("push");
  });
});
