# Reproducible paired benchmarks

The harness creates two independently seeded repositories per trial, starts a fresh non-interactive session in the named client for each raw/semantic side, and compares canonical final-state oracles. Codex, Claude Code, Cursor Agent, and Devin CLI use structured output adapters; the special `harness` client keeps the core-only fixture path for fast local checks. Timed sections exclude fixture setup and oracle collection. Trial order alternates to reduce order bias.

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

The command writes timestamped raw JSON plus a Markdown report. A short run exits `2` because it is intentionally not release-eligible. Release eligibility requires all four real clients, their versions, complete structured tool evidence, at least 30 trials per scenario/client, and every performance/correctness threshold.

Token evidence is the measured aggregate input/output usage reported by each client for an isolated Git-only session. It is labeled `isolated-git-task-session-total`; it is not an estimate of hidden reasoning or individual commands. If a client/version omits or emits unparseable usage, the value remains `null` and the release gate fails.

Each raw trial records seed, client, scenario, method, real-session status, semantic adoption, completed semantic/raw tool calls, duration, evidenced Git subprocesses, agent-facing operations, token availability, initial/final logical-state hashes, clean-state flag, `git fsck --strict`, preservation, and pair equivalence. Commands and client output are not retained. The environment records OS, hardware, Bun, Git, client versions, and tested commit SHA. Summaries include median, p95, and deterministic seeded 95% bootstrap confidence intervals.
