# usable-git v1 Technical Specification

## Context

The approved product behavior is defined in [PRODUCT.md](./PRODUCT.md). At baseline commit [`207efde`](https://github.com/LivioGama/usable-git/tree/207efde475b8cdac2ed5523869c2529e70b73d6f), tracked source contains only the README and prose rule; it exposes no semantic operation.

An untracked Bun/TypeScript `git-mine` prototype exists in `bin/git-mine.ts`, `src/`, and `tests/`. It parses Claude Code, Codex, Cursor, Devin, and OpenCode logs into SQLite and derives shell-Git episode trends. Preserve that working baseline while relocating it; it observes shell behavior but is not a repository service.

The v1 architecture is a Bun workspace with one typed operation core, two transports, and a telemetry companion:

```text
MCP stdio ─┐
           ├─ v1 schemas ─ operation service ─ guarded Git runner ─ repository
JSON CLI ──┘                    │
                               └─ opt-in redacted event sink ─ git-mine
```

Use Git CLI as the only repository backend in v1. Pin `@modelcontextprotocol/sdk@1.29.0` and `zod@4.4.3` in `bun.lock`. Direct `.git` object writes and embedded Git libraries remain out of scope.

## Proposed changes

### Workspace and ownership

- Convert the root into a private Bun workspace containing `packages/usable-git` and `packages/git-mine`; keep shared TypeScript settings at root.
- Relocate the current mining source and tests into `packages/git-mine` without behavior deletion. Complete relocation only after its existing 25-test baseline passes from the new path.
- Add `benchmarks/` for deterministic fixtures, paired agent scenarios, raw JSON results, and machine-readable environment manifests.
- Add an MIT license and ship only the `usable-git` runtime through Homebrew; do not publish an npm package.

### Versioned contracts

Create `packages/usable-git/src/contracts/v1/` as the only source of truth for request, result, envelope, error, cursor, repository-state, and telemetry-event schemas. Infer TypeScript types from Zod schemas; do not maintain parallel handwritten wire types.

The shared envelope is:

```ts
type OperationEnvelope<TResult> = {
  version: "v1";
  ok: boolean;
  operation: "inspect" | "review" | "history" | "publish" | "push";
  requestId?: string;
  repository: RepositoryState;
  backend: "git-cli";
  transport: "mcp" | "cli";
  durationMs: number;
  gitSubprocessCount: number;
  warnings: Warning[];
  result?: TResult;
  error?: OperationError;
};
```

Enforce exactly one of `result` or `error`; `ok` must agree with that branch. Define stable error codes named after PRODUCT invariants 4 and 8. Carry sanitized Git exit status and a bounded diagnostic string when useful, but never expose environment variables or secrets.

Request contracts:

- `inspect`: absolute `repoPath`; optional unique literal `files`.
- `review`: `repoPath`; optional `files`; optional opaque `cursor`; `byteCap` with a conservative default and hard maximum defined in the schema.
- `history`: `repoPath`; `ref` default `HEAD`; `limit` default 20/max 100; optional opaque `cursor`.
- `publish`: `repoPath`; non-empty unique `files`; non-empty `message`; required bounded non-empty `requestId`; required `expectedHead` union (`oid` or `unborn`); fingerprint for every file.
- `push`: `repoPath`; configured `remote`; full `sourceRef` and `targetRef` under `refs/heads/`; required `requestId`; expected source OID; `fast-forward` or `force-with-lease`, with exact expected target OID required for lease mode.

Opaque cursors encode operation, normalized-request digest, repository snapshot fingerprint, offset, and version as canonical base64url JSON with a corruption checksum. Validate every decoded field as untrusted input and reject malformed, cross-operation, cross-request, and stale cursors. The cursor contains no path or content data and remains usable across separate CLI processes.

### Guarded Git runner and parsers

Implement a single `GitRunner` that accepts argv arrays only and never invokes a shell. It must:

- Preserve `HOME` and normal system/global/local Git configuration so identity, signing, credentials, and hooks behave canonically. Set `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, and `PAGER=cat`; use explicit `--no-optional-locks` for reads.
- Remove inherited repository/config overrides including `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, object-directory overrides, external-diff variables, and `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` before setting operation-owned values.
- Disable color, external diff, and text conversion for machine-parsed reads; prevent lazy object fetching.
- Set locale to a deterministic value for parsed diagnostics while relying on machine formats for data.
- Capture stdout/stderr as bytes with operation-specific limits, count every Git subprocess, support cancellation/timeouts, and redact credentials from diagnostics.
- Never print protocol diagnostics to stdout; MCP stdout is JSON-RPC only.

Repository discovery resolves top-level path, Git directory, and common directory, then captures repository capabilities and in-progress state. Canonicalize the requested root once and validate every selected path against it.

Literal path validation must reject empty values, absolute paths, `.`, directories, duplicates, globs, pathspec magic, and `..` escapes. Publish additionally rejects ignored paths and gitlinks; read operations may classify them. Pass validated paths through NUL-delimited `--pathspec-from-file=- --pathspec-file-nul` with top-level `git --literal-pathspecs` where the subcommand supports it; otherwise pass argv after validation with `--`.

Dedicated parsers own Git's stable machine outputs:

- Porcelain v2 `-z` parser for branch/upstream and staged/unstaged/untracked/conflicted/rename state.
- Raw/name-status/numstat diff parsers for staged and unstaged evidence, including binary entries and unusual filenames.
- NUL/record-delimited log parser for OIDs, parents, identities, messages, timestamps, and signature status.
- `ls-files`, `check-ignore`, `rev-parse`, and `for-each-ref` parsers for validation and ref resolution.

Parsers accept bytes and return typed data. No operation module parses human-oriented output inline.

### Read operations

Implement operations in dependency order: `inspect`, `review`, then `history`.

- `inspect` takes one coherent local snapshot and derives per-change fingerprints from normalized state plus selected content/index identities. It reports unborn HEAD without error and never contacts a remote.
- `review` independently obtains `HEAD→index` and `index→worktree` evidence. Read explicit untracked files directly only after path validation. Build deterministic pages by canonical path/order and byte accounting; bind cursor to the inspect snapshot.
- `history` validates a local ref/object without fetch, reads newest-first records, and paginates against a bound start OID. Empty unborn history is successful.

Expose read tools with accurate MCP annotations: read-only, idempotent, and closed-world. Annotations are metadata, not authorization; client policy still controls writes.

### Mutation safety foundation

Before `publish` or `push`, add:

- A lock file keyed by canonical Git common-dir, using atomic exclusive creation and bounded stale-lock diagnosis. Do not automatically steal a live lock.
- An external journal at `$XDG_STATE_HOME/usable-git`, falling back to `~/.local/state/usable-git`, keyed by repository hash and request ID. Never journal inside the target working tree.
- Request-id records containing normalized request hash, phase, observed pre-state, owned intermediate checksums, and terminal result. Reuse with a different request body is an error.
- Recovery that runs before a new mutation. Each phase resolves to confirmed success, safe rollback, known failure, explicit ambiguous outcome, or `recovery_conflict`.

Journal writes use write-to-temp, fsync, atomic rename, and parent-directory sync where supported. Keep completed records long enough to provide idempotency; bound retention by age and count without deleting active/ambiguous records.

### Publish

Implement `publish` with canonical Git exact-path commit behavior, not direct object writes:

1. Validate request, repository capabilities, HEAD expectation, and every selected fingerprint.
2. Acquire common-dir lock and revalidate all expectations.
3. Snapshot exact index bytes, index metadata/checksum, HEAD, branch ref, and full pre-operation status fingerprint into the journal.
4. For selected untracked files, make them known with intent-to-add while preserving the original index snapshot.
5. Invoke `git commit --only` with literal selected paths and the supplied message so the commit tree contains complete current selected contents but excludes unrelated index entries. Preserve hooks, signing, identity, and repository configuration.
6. Observe HEAD immediately after Git returns. If changed, mark commit observed and never reset HEAD.
7. If no commit was observed, restore exact original index bytes only when the current index checksum matches the service-owned intermediate checksum. Otherwise return `recovery_conflict` without overwrite.
8. Verify resulting commit tree, selected paths, and unrelated status/index preservation; persist terminal result and release lock. Integration/property tests run `git fsck --strict` on the completed fixture.

Unborn HEAD follows the same path but uses the explicit `unborn` expectation. Add integration fixtures to prove unrelated pre-staged files remain staged and absent from the initial commit.

### Push

Implement one explicit ref update per request:

1. Validate configured remote name and full branch refs; reject URLs, tags, deletions, wildcard/multiple refspecs, and implicit upstreams.
2. Acquire lock, resolve source, compare expected source OID, and record explicit target expectation.
3. Fast-forward mode pushes one `sourceRef:targetRef` without force. Lease mode adds exactly `--force-with-lease=<targetRef>:<expectedTargetOid>`; never use blind `--force` or an empty lease.
4. Record subprocess start and completion phases. On uncertain transport failure, query only the configured remote's explicit target ref with `ls-remote`.
5. Compare remote target to expected old/new OIDs and return confirmed success, confirmed failure, or `network_ambiguous`. Never retry the update automatically.

Mark the MCP push tool destructive and open-world. Apply explicit write approval/session policy during each client installation rather than relying on annotations.

### MCP, CLI, installer, and doctor

Expose one stdio MCP server with exactly five tools. Register each tool with its input schema, `outputSchema`, accurate annotations, and both `structuredContent` and a compact text summary. Validate outgoing structured results before sending them.

Expose the same service through:

```text
usable-git inspect|review|history|publish|push --json [flags]
usable-git <operation> --input -
usable-git mcp
usable-git install --clients all [--force]
usable-git doctor --clients all
```

`--input -` reads one JSON request from stdin. JSON mode writes one envelope to stdout and diagnostics to stderr. Exit 0 only for `ok: true`; map all operation failures to a stable non-zero exit without changing the JSON error contract.

Installer behavior:

- Codex, Claude Code, and Devin: use each installed client's native MCP registration command non-interactively.
- Cursor: atomically merge the MCP entry into its JSON configuration because its CLI has no `mcp add` command.
- Preserve unrelated configuration byte-for-byte where the native client permits and structurally where JSON merge is required. Matching entries are idempotent; conflicts require `--force`.
- Register an absolute executable path and local stdio transport. Never embed secrets.

Doctor uses isolated temporary repositories and a local bare remote. It checks runtime versions, direct JSON CLI operations, raw MCP initialize/list/call and exact schemas, dirty-tree publish preservation, single-ref push, all client registrations, and a fresh-session semantic invocation from each requested client. Emit a structured pass/fail/skip report and fail if a required check fails.

### Routing rule and distribution

Replace the prose rule with a thin router: use semantic MCP when applicable, JSON CLI when MCP is unavailable, and exact-path raw Git only when the requested capability is outside v1. A semantic safety rejection is terminal; the rule must not bypass it with raw Git.

Install the rule only through the canonical `~/.agent-config/rules/usable-git.md`, then run `~/agent-config/build.sh` and verify generated client files. Never edit generated global agent files directly.

Publish through `LivioGama/homebrew-tap` as `Formula/usable-git.rb`, depending on Homebrew `bun` and `git`. Release automation updates version and SHA, runs `brew audit --strict`, and executes a formula test covering MCP handshake, dirty-tree publish, and local-bare-remote push on clean macOS and Linux environments.

### Telemetry and git-mine

Telemetry is disabled unless explicitly enabled. Emit one versioned event at the operation boundary containing only fields allowed by PRODUCT invariants 54–56. Salt and hash the canonical repository identity locally; never write raw paths or file identifiers.

Extend `git-mine` to ingest semantic MCP/CLI events alongside legacy shell episodes and report:

- Applicable semantic invocations versus raw fallbacks.
- Repeated-read elimination.
- Correctness/recovery outcomes.
- Agent-facing operation count.
- Git-related token estimate and end-to-end latency.
- Client, transport, backend, and version distribution.

Legacy migration creates a separate redacted database. Preserve the old database unless the user explicitly removes it.

## Testing and validation

- Contract tests validate every request/result/error schema, envelope branch, cursor rule, telemetry whitelist, and MCP annotation (PRODUCT 1–5, 54–56).
- Parser fixtures cover NUL-delimited porcelain v2, renames, conflicts, binary files, Unicode and newline filenames, SHA-1/SHA-256 OIDs, worktrees, and truncated/malformed output (PRODUCT 11–28).
- Read integration tests compare `inspect`, `review`, and `history` results against canonical Git in clean, dirty, staged, untracked, conflicted, unborn, and paginated repositories. Assert zero mutation and network access (PRODUCT 6, 11–28).
- Publish differential tests compare HEAD, commit tree, exact index bytes, status, and unrelated file contents before/after; include add/modify/delete/rename, nested files, initial commits, hooks, signing failure, missing identity, contention, stale expectations, and every refused repository state (PRODUCT 7–10, 29–39).
- Push tests use local bare remotes and cover fast-forward, non-fast-forward, exact lease success/rejection, stale source, invalid refs/remotes, authentication classification fixtures, and injected ambiguous outcomes (PRODUCT 40–47).
- Crash injection executes every journal phase and proves recovery ends in confirmed success, safe rollback, known failure, or explicit ambiguity/conflict; never silent loss.
- Property testing creates at least 1,000 seeded randomized dirty repositories. Required oracle: zero unrelated paths staged, unstaged, committed, edited, deleted, or lost.
- Every successful mutation fixture verifies `git status --porcelain=v1`, readable `git log`, expected refs/tree/index, and `git fsck --strict`.
- Installer/doctor tests start from clean configs for all four clients, preserve sentinel unrelated entries, test conflict/force behavior, and perform fresh-session invocation (PRODUCT 48–53).
- Homebrew tests run on clean macOS and Linux and execute the real formula-installed MCP/publish/push paths.
- Paired agent benchmarks run at least 30 trials per scenario per client and record raw JSON, trial seed, hardware/OS, Bun/Git/client versions, commit SHA, median, p95, confidence intervals, subprocess counts, agent operations, token measurements, and final-state oracles.
- Release requires every gate in PRODUCT invariant 59. Roll out trials Codex → Claude Code → Cursor Agent → Devin CLI; do not tag v1 until all four pass.

Long randomized, cross-client, and Homebrew matrices run remotely after syncing the exact commit; quick module and fixture tests run locally. Do not use the build/dev-server commands prohibited by repository agent rules.

## Risks and mitigations

- **Git state corruption:** exact index snapshots, common-dir locks, phase journals, checksum-guarded restore, differential tests, crash injection, and `fsck` verification.
- **Hooks mutate repository state:** re-observe HEAD/index/status after commit and never overwrite an index whose checksum is no longer service-owned.
- **Ambiguous network success:** query only the explicit target ref and return ambiguity instead of retrying.
- **Path injection or scope widening:** reject non-literal paths and use argv plus NUL-delimited literal pathspecs.
- **Protocol corruption or secret leakage:** reserve stdout for protocol/JSON, bound diagnostics, redact secrets, and schema-test telemetry.
- **Client registration drift:** native registration where available, atomic Cursor merge, exact doctor schema checks, and fresh-session invocation.
- **Misleading performance claims:** retain historical numbers only as unverified context; publish new claims only from committed reproducible artifacts.

## Parallelization

Use parallel agents because the implementation separates cleanly after contracts land:

- **Core/read agent (local shared checkout `/Users/livio/Documents/usable-git`):** schemas, runner, discovery, parsers, `inspect`, `review`, `history`, and their tests.
- **Mutation agent (same shared checkout, disjoint `packages/usable-git/src/mutations` ownership):** begin after schemas/runner interfaces are frozen; locks, journals, `publish`, `push`, recovery, property/crash tests.
- **Telemetry/distribution agent (same shared checkout, disjoint `packages/git-mine`, installer/doctor, and delivery-file ownership):** `git-mine` relocation/extension, installer, doctor, Homebrew formula/release workflow, and client fixtures.

Subagents do not commit from the shared checkout. The parent stages explicit owned paths and lands one combined PR with linear commits; no merge commits. Agents own disjoint modules and exchange only frozen contract fixtures. The parent owns integration, routing-rule deployment, full matrix verification, and release-gate evidence. Sequence: contracts → parallel core/mutations/delivery → integration → remote matrices → release.
