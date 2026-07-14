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

The v1 release candidate now implements the five operations, guarded mutation recovery,
matching CLI/MCP transports, client registration, doctor diagnostics, metadata-only
telemetry, semantic `git-mine` ingestion, property tests, and reproducible benchmark and
Homebrew release gates. The decision-complete specifications are:

- [Product behavior](specs/usable-git-v1/PRODUCT.md)
- [Technical design and verification](specs/usable-git-v1/TECH.md)

Do not treat the current checkout as a released service. The macOS and Linux formula
candidates have passed source installation and real MCP/publish/push tests. The installed
macOS candidate also passed prior fresh-session activation checks in Codex, Claude Code,
Cursor Agent, and Devin CLI. The public tap remains unchanged until every release gate
passes. The current local non-Cursor benchmark policy requires Codex, Claude Code, and
Devin CLI with 40 paired trials per scenario/client; adoption, token, and p95 gates remain
unproven release blockers until that local matrix passes.

## Source-checkout usage

Install locked workspace dependencies:

```sh
bun install --frozen-lockfile
```

Run one semantic operation through explicit JSON flags:

```sh
bun packages/usable-git/src/cli.ts inspect --json --repo-path "$PWD"
```

Or send the same request as one JSON object on stdin:

```sh
printf '%s\n' "{\"repoPath\":\"$PWD\"}" |
  bun packages/usable-git/src/cli.ts inspect --input -
```

The protocol server is local stdio:

```sh
bun packages/usable-git/src/cli.ts mcp
```

`install --clients all` and `doctor --clients all` are intended for the stable Homebrew
executable path. Do not register a transient source-checkout path in permanent client
configuration.

## Safety model

V1 is deliberately narrow:

- Explicit literal files only.
- Optimistic HEAD and change fingerprints for mutations.
- One lock and crash-recovery journal per Git common directory.
- No silent expansion to directories, globs, implicit upstreams, or multiple refs.
- Unrelated staged, unstaged, and untracked work must survive unchanged.
- Ambiguous remote outcomes are reported, never blindly retried.
- Direct Git object writes are excluded from v1.

The v1 routing rule allows unsupported operations to fall back to scoped raw Git. A
rejected semantic mutation never falls back to a broader command that bypasses its safety
decision.

## Release gates

V1 will not be tagged until reproducible evidence shows:

- 100% repository correctness and recovery.
- Zero unrelated-work loss or corruption.
- 100% clean-install activation across Codex, Claude Code, and Devin CLI.
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
