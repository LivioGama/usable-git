# usable-git

A speed proof for exposing Git to agents as semantic repository operations instead of repeated shell commands.

## Semantic Git Speed Proof

Benchmark date: 2026-07-03  
Runtime: Bun 1.3.14, Git 2.54.0, macOS arm64  
Trials: 100 per scenario

## What Changed

The semantic wrapper uses a fast publish path for explicit root files in a simple repository with no existing `HEAD`.

Instead of shelling out to:

```text
git add
git diff --cached --name-only
git commit
git rev-parse
git status
```

the fast path writes Git data directly:

- blob object
- tree object
- commit object
- index file
- branch ref

Unsupported cases fall back to the Git-backed implementation. Broad staging is refused unless explicitly allowed.

## Benchmark Result

| Metric | Raw Git Commit | Semantic Publish | Result |
|---|---:|---:|---|
| Success rate | 100% | 100% | Tie |
| Final clean repo state | 100% | 100% | Tie |
| Median wall-clock | 18.94 ms | 0.89 ms | Semantic is 21.3x faster |
| P95 wall-clock | 22.59 ms | 1.04 ms | Semantic is 21.7x faster |
| Shell/Git processes in hot path | 2 | 0 | Semantic eliminates subprocesses |
| Agent-facing operations | 3 | 2 | Semantic reduces by 33.3% |

## Interpretation

This is a speed proof for a scoped semantic publish path. The speedup comes from removing Git process startup and command parsing from the hot path while keeping the agent-facing API small.

This is not a complete Git replacement. The fast path is intentionally narrow:

- explicit paths only
- root-level regular files only
- simple repositories with no existing `HEAD`
- no broad staging unless explicitly allowed

That scope is enough to prove the architectural claim: a semantic repository API can be materially faster than driving Git through repeated shell commands when the backend owns repository state transformations directly.

## Verification

Commands run locally:

```sh
bun test
bun scripts/benchmark.mjs --trials 100
```

Results:

- Test suite: 7 pass, 0 fail, 61 assertions.
- Benchmark: 100/100 successful raw trials.
- Benchmark: 100/100 successful semantic trials.
- Both workflows left repos clean in 100% of trials.
- Regression test confirms fast publish creates a valid Git commit with `0` Git subprocesses in the hot path, and `git fsck --strict` accepts it.
