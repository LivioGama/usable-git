# Reproducible paired benchmarks

The harness creates two independently seeded repositories per trial, applies the same scenario through raw Git and the `usable-git` operation core, and compares canonical final-state oracles. Timed sections exclude fixture setup and oracle collection. Trial order alternates to reduce order bias.

Release-sized run (offload from a developer Mac):

```bash
bun benchmarks/run.ts \
  --clients codex,claude-code,cursor,devin \
  --client-version codex=<version> \
  --client-version claude-code=<version> \
  --client-version cursor=<version> \
  --client-version devin=<version> \
  --trials 30 \
  --seed 20260714 \
  --output benchmarks/results
```

Fast fixture check:

```bash
bun benchmarks/run.ts \
  --clients harness \
  --scenarios inspect-dirty,publish-scoped \
  --trials 2 \
  --seed 20260714 \
  --allow-short-run \
  --output /tmp/usable-git-benchmark
```

The command writes timestamped raw JSON plus a Markdown report. A short run exits `2` because it is intentionally not release-eligible. Missing client versions or Git-related token measurements stay `null`; the release gate fails instead of inventing data.

Each raw trial records seed, client, scenario, method, duration, Git subprocesses, agent-facing operations, token availability, initial/final logical-state hashes, clean-state flag, `git fsck --strict`, preservation, and pair equivalence. The environment records OS, hardware, Bun, Git, client versions, and tested commit SHA. Summaries include median, p95, and deterministic seeded 95% bootstrap confidence intervals.
