---
id: usable-git
title: Usable Git
description: Treat Git as a semantic repository API for agents, preserving user work while reducing repeated shell Git operations.
---

# Usable Git (GLOBAL RULE)

Treat Git as a repository state-management API, not as a transcript of shell commands.

## Core Rule

Think in repository transformations first:

```text
agent intent -> semantic operation -> repository state change -> structured result
```

Prefer semantic operations:

- `publish(paths, message)`
- `checkpoint(paths, label)`
- `review(task)`
- `history(limit)`
- `undo(operation)`
- `restore(label)`
- `split(by="intent")`
- `move(change, destination)`

Use raw Git commands as backend implementation details, not as the default agent-facing interface.

## Working Tree Safety

Preserve user work by default.

- Require explicit paths for commit-like operations.
- Refuse broad staging paths such as `.`, `./`, and `:/` unless the caller explicitly opts into broad staging.
- Never publish unrelated dirty files.
- Never use `git add .` as a default staging strategy.
- Keep tests attached to the feature or fix they validate.
- Keep benchmark data intact when improving docs, code, or implementation.

## Performance Principle

Repeated shell Git calls are expensive for agents because each call creates latency, text output, token load, and another reasoning step.

When a higher-level repository operation is available, prefer it over command chains like:

```text
git status
git diff
git add
git commit
git rev-parse
git status
```

A semantic operation should return structured results: changed files, commit hash, clean/dirty status, telemetry, and recoverable errors.

## Speed-Proof Standard

When claiming a speed improvement, benchmark raw Git and semantic Git with the same final repository state.

Report at least:

| Metric | Purpose |
|---|---|
| success rate | Proves correctness across repeated trials |
| final clean state | Proves the workflow leaves the repo usable |
| median wall-clock | Shows typical speed |
| p95 wall-clock | Shows tail latency |
| shell/Git subprocesses | Measures process-launch overhead |
| agent-facing operations | Measures reasoning/API surface reduction |

Do not replace benchmark data with vague claims. Preserve the table and raw numbers.

## Current Usable Git Proof

The `usable-git` prototype proved a scoped semantic publish path:

| Metric | Raw Git Commit | Semantic Publish |
|---|---:|---:|
| Median wall-clock | 18.94 ms | 0.89 ms |
| P95 wall-clock | 22.59 ms | 1.04 ms |
| Shell/Git processes in hot path | 2 | 0 |
| Agent-facing operations | 3 | 2 |
| Success rate | 100% | 100% |

The fast path writes Git data directly:

- blob object
- tree object
- commit object
- index file
- branch ref

## Direct Object Write Boundary

Use direct Git object writes only when constraints are explicit and verified.

Safe fast path scope:

- explicit paths only
- root-level regular files only
- simple repositories with no existing `HEAD`
- fallback to Git-backed behavior for unsupported cases

Do not generalize the speed claim beyond the verified benchmark scope without adding matching tests and benchmark data.

## Verification Checklist

Before calling repository work complete:

1. Run the relevant unit tests.
2. Run the benchmark with enough trials to avoid timing noise.
3. Verify generated repositories with `git status --porcelain=v1`.
4. Verify commit readability with `git log` or equivalent history parsing.
5. Run `git fsck --strict` for direct object-write paths.
6. Confirm README benchmark data was preserved, not replaced by vague claims.
