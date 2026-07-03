---
name: usable-git
description: Semantic Git workflow and speed-proof guidance for coding agents. Use when designing, implementing, benchmarking, or reviewing agent-facing Git operations that should replace repeated shell Git commands with safe repository primitives such as publish, checkpoint, review, history, undo, restore, split, or move.
---

# Usable Git

Use this skill to turn Git work into semantic repository operations instead of shell-command transcripts.

## Core Model

Think in repository transformations first:

```text
agent intent -> semantic operation -> repository state change -> structured result
```

Prefer operations like:

- `publish(paths, message)`
- `checkpoint(paths, label)`
- `review(task)`
- `history(limit)`
- `undo(operation)`
- `restore(label)`
- `split(by="intent")`
- `move(change, destination)`

Treat raw Git commands as backend implementation details, not as the agent-facing API.

## Safety Rules

Preserve user work by default.

- Require explicit paths for commit-like operations.
- Refuse broad staging paths such as `.`, `./`, and `:/` unless the caller explicitly opts into broad staging.
- Never publish unrelated dirty files.
- Keep tests attached to the feature or fix they validate.
- Keep benchmark data intact when improving docs or implementation.
- Validate direct Git object writes with real Git commands, including `git status`, `git log`, and `git fsck --strict`.

## Speed-Proof Protocol

When claiming a speed improvement, benchmark both raw Git and semantic Git with the same final repository state.

Report at least:

| Metric | Purpose |
|---|---|
| success rate | Proves correctness across repeated trials |
| final clean state | Proves the workflow leaves the repo usable |
| median wall-clock | Shows typical speed |
| p95 wall-clock | Shows tail latency |
| shell/Git subprocesses | Measures process-launch overhead |
| agent-facing operations | Measures reasoning/API surface reduction |

Preserve the benchmark table and raw data when updating a README.

## Current Speed Proof

The `usable-git` prototype proved a scoped semantic publish path:

| Metric | Raw Git Commit | Semantic Publish |
|---|---:|---:|
| Median wall-clock | 18.94 ms | 0.89 ms |
| P95 wall-clock | 22.59 ms | 1.04 ms |
| Shell/Git processes in hot path | 2 | 0 |
| Agent-facing operations | 3 | 2 |
| Success rate | 100% | 100% |

This fast path writes Git data directly:

- blob object
- tree object
- commit object
- index file
- branch ref

## Fast Path Boundaries

Use direct object writes only when the constraints are explicit and verified.

The current safe fast path is intentionally narrow:

- explicit paths only
- root-level regular files only
- simple repositories with no existing `HEAD`
- fallback to Git-backed behavior for unsupported cases

Do not generalize the speed claim beyond the verified benchmark scope without adding matching tests and benchmark data.

## Verification Checklist

Before calling the work done:

1. Run the unit tests for the semantic wrapper.
2. Run the benchmark with enough trials to avoid one-off timing noise.
3. Verify the generated repository with `git status --porcelain=v1`.
4. Verify commit readability with `git log` or equivalent history parsing.
5. Run `git fsck --strict` for direct object-write paths.
6. Confirm README benchmark data was preserved, not replaced by vague claims.
