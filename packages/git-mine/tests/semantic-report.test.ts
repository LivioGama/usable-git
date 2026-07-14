import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAdoptionReport } from "../src/semantic/report";
import { openRedactedDatabase } from "../src/semantic/redacted-store";

let directory: string | undefined;

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("adoption reporting", () => {
  test("distinguishes semantic use, applicable raw fallback, repeated reads, outcomes, counts, latency, and versions", async () => {
    directory = await mkdtemp(join(tmpdir(), "git-mine-report-"));
    const database = openRedactedDatabase(join(directory, "redacted.db"));
    database.run(`
      INSERT INTO semantic_events
        (version, operation, client, transport, backend, duration_ms, git_subprocess_count,
         result_code, selected_count, staged_count, unstaged_count, untracked_count,
         conflicted_count, commit_count, warning_count, usable_git_version, bun_version,
         git_version, client_version, repository_hash)
      VALUES
        ('v1', 'inspect', 'codex', 'mcp', 'git-cli', 10, 1, 'success', 0, 0, 0, 0, 0, 0, 0,
         '0.1.0', '1.3.14', '2.54.0', '0.114.0', '${"a".repeat(64)}'),
        ('v1', 'publish', 'codex', 'mcp', 'git-cli', 30, 3, 'HOOK_FAILED', 1, 0, 0, 0, 0, 0, 0,
         '0.1.0', '1.3.14', '2.54.0', '0.114.0', '${"a".repeat(64)}')
    `);
    database.run(`
      INSERT INTO raw_fallbacks
        (client, applicable_operation, result_code, raw_git_operations, repeated_read_count,
         llm_operations, context_operations, estimated_git_tokens, duration_ms)
      VALUES
        ('claude-code', 'review', 'success', 3, 1, 6, 2, 120, 40),
        ('codex', 'publish', 'success', 2, 0, 4, 1, 80, 20),
        ('cursor-agent', NULL, 'success', 1, 0, 2, 0, 40, 10)
    `);

    const report = generateAdoptionReport(database);
    database.close();

    expect(report.adoption).toEqual({
      semanticInvocations: 2,
      applicableRawFallbacks: 2,
      nonApplicableRawOperations: 1,
      semanticAdoptionRate: 0.5,
    });
    expect(report.repeatedReads).toEqual({
      observedRawRepeats: 1,
      semanticReadInvocations: 1,
    });
    expect(report.agentFacingOperations).toEqual({ semantic: 2, raw: 6, total: 8 });
    expect(report.estimatedGitTokens).toEqual({ semantic: null, raw: 240 });
    expect(report.latencyMs).toEqual({ semanticMedian: 20, semanticP95: 30, rawMedian: 20, rawP95: 40 });
    expect(report.outcomes).toEqual({ HOOK_FAILED: 1, success: 4 });
    expect(report.distributions.clients).toEqual({
      "claude-code": 1,
      codex: 3,
      "cursor-agent": 1,
    });
    expect(report.distributions.transports).toEqual({ mcp: 2, raw: 3 });
    expect(report.distributions.backends).toEqual({ "git-cli": 2, raw: 3 });
    expect(report.distributions.versions).toEqual({ "usable-git@0.1.0": 2, legacy: 3 });
  });
});
