# usable-git

Semantic Git operations for coding agents.

`usable-git` is moving from a prose rule and measurement prototype to an executable repository service. The v1 contract gives agents five structured operations:

| Operation | Purpose |
|---|---|
| `inspect` | Read local repository, branch, and change state in one structured snapshot. |
| `review` | Return staged and unstaged evidence without mixing the two. |
| `history` | Read deterministic, paginated local commit history. |
| `publish` | Commit exact files while preserving every unrelated change. |
| `push` | Update exactly one explicit remote branch with fast-forward or exact lease safety. |

MCP is the primary transport. A JSON CLI provides the same schemas and results when MCP is unavailable. Git CLI remains the v1 repository backend.

## Status

V1 is under implementation. The approved, decision-complete specifications are:

- [Product behavior](specs/usable-git-v1/PRODUCT.md)
- [Technical design and verification](specs/usable-git-v1/TECH.md)

Do not treat the current checkout as a released semantic Git service until the release gates in those specs pass. Homebrew installation, client activation, semantic commands, and performance targets are release deliverables—not current guarantees.

The existing executable baseline is `git-mine`, a Bun/TypeScript prototype that parses agent logs and measures shell-Git episode shapes. It does not yet provide repository mutation operations.

## Safety model

V1 is deliberately narrow:

- Explicit literal files only.
- Optimistic HEAD and change fingerprints for mutations.
- One lock and crash-recovery journal per Git common directory.
- No silent expansion to directories, globs, implicit upstreams, or multiple refs.
- Unrelated staged, unstaged, and untracked work must survive unchanged.
- Ambiguous remote outcomes are reported, never blindly retried.
- Direct Git object writes are excluded from v1.

The v1 routing rule will allow unsupported operations to fall back to scoped raw Git. A rejected semantic mutation will never fall back to a broader command that bypasses its safety decision.

## Release gates

V1 will not be tagged until reproducible evidence shows:

- 100% repository correctness and recovery.
- Zero unrelated-work loss or corruption.
- 100% clean-install activation across Codex, Claude Code, Cursor Agent, and Devin CLI.
- At least 95% semantic-tool adoption when applicable.
- At least 50% fewer agent-facing Git operations.
- At least 30% lower Git-related tokens and p95 end-to-end time.

Benchmark artifacts must include raw results, trial counts, environment and component versions, commit SHA, median, p95, confidence intervals, and final-state oracles.

## Historical prototype result

The previous README reported the following direct-object-write benchmark from 2026-07-03 on Bun 1.3.14, Git 2.54.0, and macOS arm64:

| Metric | Raw Git commit | Prototype semantic publish |
|---|---:|---:|
| Success rate | 100% | 100% |
| Final clean state | 100% | 100% |
| Median wall-clock | 18.94 ms | 0.89 ms |
| P95 wall-clock | 22.59 ms | 1.04 ms |
| Git subprocesses in hot path | 2 | 0 |
| Agent-facing operations | 3 | 2 |

These numbers are **historical and unverified in the current checkout**: the raw benchmark artifacts and runnable benchmark path are not present. They are not a v1 performance claim. The tested fast path was limited to root-level regular files in repositories without an existing HEAD and wrote Git objects/index/refs directly; v1 intentionally uses guarded Git CLI semantics instead.

## License

MIT. See [LICENSE](LICENSE).
