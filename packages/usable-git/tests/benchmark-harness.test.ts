import { describe, expect, test } from "bun:test";
import { runBenchmarkMatrix } from "../../../benchmarks/runner.ts";

describe("paired benchmark harness", () => {
  test("proves equivalent final state for inspect and publish fixtures", async () => {
    const artifact = await runBenchmarkMatrix({
      clients: ["harness"],
      scenarios: ["inspect-dirty", "publish-scoped"],
      trials: 2,
      seed: 7_331,
      allowShortRun: true,
    });

    expect(artifact.schemaVersion).toBe("usable-git-benchmark-v1");
    expect(artifact.trials).toHaveLength(8);
    expect(artifact.trials.every(({ oracle }) => oracle.equivalent && oracle.valid)).toBe(true);
    expect(artifact.summary.every(({ successRate }) => successRate === 1)).toBe(true);
    expect(artifact.environment.clientVersions.harness).toBeNull();
    expect(artifact.trials.every(({ gitRelatedTokens }) => gitRelatedTokens.value === null)).toBe(
      true,
    );
    const publish = artifact.summary.filter(({ scenario }) => scenario === "publish-scoped");
    const raw = publish.find(({ method }) => method === "raw-git")!;
    const semantic = publish.find(({ method }) => method === "semantic")!;
    expect(raw.agentFacingOperations.median).toBeGreaterThanOrEqual(4);
    expect(semantic.agentFacingOperations.median).toBeLessThanOrEqual(2);
    expect(1 - semantic.agentFacingOperations.median / raw.agentFacingOperations.median)
      .toBeGreaterThanOrEqual(0.5);
  }, 20_000);

  test("refuses release artifacts below 30 trials per scenario and client", async () => {
    await expect(
      runBenchmarkMatrix({
        clients: ["codex"],
        scenarios: ["inspect-dirty"],
        trials: 2,
        seed: 1,
      }),
    ).rejects.toThrow("at least 30 trials");
  });
});
