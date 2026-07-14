# usable-git v1 Product Specification

## Summary

`usable-git` gives coding agents a small, structured Git surface instead of requiring them to compose shell command chains. Version 1 provides safe local inspection, review, history, scoped commit creation, and single-branch push through MCP with a JSON CLI fallback.

## Problem

The existing rule asks agents to think in semantic repository operations, but no executable semantic interface exists. Agents still spend tool calls and context on shell commands, parse unstable text output, and can accidentally stage or publish unrelated user work.

## Goals and non-goals

Goals:

- Make the common inspect, review, history, publish, and push workflows callable as one structured operation each.
- Preserve unrelated repository state under success, failure, cancellation, contention, and recovery.
- Activate the same contracts in Codex, Claude Code, Cursor Agent, and Devin CLI.
- Produce enough local metadata to prove correctness, adoption, operation-count, token, and latency improvements.

Non-goals for v1:

- Replacing every Git command or exposing arbitrary Git argv.
- Direct object writes or an embedded Git implementation.
- Checkpoints, undo/restore, split/move, hunk staging, amend, branch creation, merge/rebase, fetch/pull, tags, remote deletion, multi-ref push, or submodule mutation.
- AI-generated review findings.
- Publishing telemetry or repository content to a remote service.

## Behavior

### Shared contract

1. Consumers receive exactly five semantic operations: `inspect`, `review`, `history`, `publish`, and `push`.

2. Every operation accepts an absolute `repoPath`. Relative paths, missing paths, non-repositories, and repository paths the caller cannot read return a structured error without changing repository state.

3. Every response uses a versioned `v1` envelope containing:
   - `ok`.
   - Operation name and request ID when supplied.
   - Repository state relevant to the result.
   - Backend and transport metadata.
   - Duration and Git subprocess count.
   - Warnings.
   - Exactly one of a typed result or a structured error.

4. Stable error codes distinguish invalid input, invalid repository or path, unsupported repository state, stale expectations, busy repository, nothing to commit, hook/signing/identity/authentication failures, non-fast-forward push, lease rejection, ambiguous network outcome, recovery conflict, and invariant violation.

5. The MCP and JSON CLI surfaces accept equivalent inputs and return equivalent envelopes. An agent can fall back from MCP to CLI without changing operation semantics.

6. Read operations never fetch, modify files, modify the index, move refs, change configuration, create a stash, or contact a remote.

7. Mutating operations require explicit scope and optimistic expectations. They fail safely when the repository has changed since inspection; they never silently widen scope to make progress.

8. Detached HEAD, unresolved conflicts, merge/rebase/cherry-pick/revert sequencer state, bare repositories, sparse or split indexes, and requested submodule mutation are refused in v1 before mutation begins.

9. Concurrent mutating requests against the same repository share one repository-level exclusion boundary. A second request receives `busy_repository`; it does not race or wait indefinitely.

10. Repeating a mutating request with the same request ID is idempotent. The caller receives the known prior outcome or an explicit ambiguous/recovery error; a second commit or blind second push is never created.

### Inspect

11. `inspect` accepts `repoPath` and an optional list of literal file paths relative to the repository root.

12. A successful `inspect` returns one local snapshot containing HEAD state, current branch, configured upstream, in-progress operation state, stash count, and staged, unstaged, untracked, and conflicted entries.

13. Each changed entry identifies its state and repository-relative path. Renames include the origin path. Each entry includes a fingerprint suitable for a later stale-state check.

14. When files are supplied, only those exact literal paths are returned. `.` and directory, glob, pathspec-magic, and repository-escaping selections are rejected rather than expanded. Read operations may report ignored or gitlink state, but mutating those entries remains unsupported.

15. An unborn repository is valid inspection input. The result explicitly reports no HEAD instead of treating the repository as invalid.

16. Clean repositories return empty change collections, not an error.

### Review

17. `review` accepts `repoPath`, optional literal files, an optional pagination cursor, and an optional response byte cap.

18. A successful review keeps staged evidence (`HEAD` to index) separate from unstaged evidence (index to working tree), with per-path statistics and binary markers.

19. Review reports source and destination paths for renames and never drops binary or unusual-filename entries merely because text content is unavailable.

20. Untracked file contents are excluded by default. They are included only when the caller explicitly names those exact files.

21. Large results are deterministically paginated. The same repository snapshot, selection, byte cap, and cursor produce the same next page and cursor.

22. A cursor tied to a stale repository snapshot fails with `stale_state`; pages from different repository states are never combined silently.

23. Review returns repository evidence only. It does not invent findings, assign severity, or interpret code quality.

### History

24. `history` accepts `repoPath`, a local ref defaulting to `HEAD`, a limit defaulting to 20 and capped at 100, and an optional cursor.

25. A successful history result is newest-first and includes each commit's object ID, parent IDs, author/committer metadata, complete message subject and body within the response cap, timestamp, and signature status.

26. History resolves only local refs and objects. Missing or invalid refs return a structured error; the operation never fetches them.

27. Pagination is deterministic and stale cursors fail explicitly.

28. An unborn repository returns an empty history result with explicit unborn-HEAD state.

### Publish

29. `publish` accepts `repoPath`, a non-empty exact file list, a non-empty commit message, a request ID, expected HEAD (including an explicit unborn value), and expected fingerprints for every selected change.

30. Publish commits the complete current contents or deletion of each selected file as one local commit. It does not push.

31. Publish never stages, unstages, commits, edits, deletes, or otherwise changes an unrelated file. Existing unrelated staged entries remain staged and unrelated unstaged/untracked entries remain unchanged.

32. New selected files can be committed, including in an unborn repository, without pulling unrelated staged entries into the commit.

33. Selected paths must be literal repository-relative files. Empty selections, `.`, directories, globs, pathspec magic, ignored files, gitlinks, duplicates, and paths outside the repository are rejected.

34. Publish checks expected HEAD and all selected fingerprints immediately before mutation. Any mismatch returns `stale_state` and creates no commit.

35. Existing Git commit hooks, author identity, signing configuration, and commit-message validation are honored. A hook, identity, or signing failure is returned with a stable error code.

36. If publish fails before Git reports a new commit, the original index is restored only when safe to do so. If another actor changed the index during the operation, publish stops with `recovery_conflict` and does not overwrite that work.

37. Once a new commit is observed, publish never resets or rewrites HEAD as rollback. The result reports the observed commit and any recovery warning.

38. A successful publish returns the new commit ID, committed paths, resulting HEAD/branch state, and enough status metadata to prove unrelated work was preserved.

39. A selection with no committable difference returns `nothing_to_commit`; no empty commit is created.

### Push

40. `push` accepts `repoPath`, a configured remote name, full source and target branch refs, request ID, expected source object ID, and an explicit mode.

41. Push updates exactly one remote branch. It rejects raw remote URLs, implicit upstreams, short/ambiguous refs, tags, deletes, wildcard or multi-ref refspecs, and unconfigured remotes.

42. Fast-forward mode never forces. A non-fast-forward result returns `non_fast_forward` without retrying as force.

43. Lease mode requires the exact expected target object ID and uses force-with-lease semantics. Blind force and lease values inferred after the request begins are prohibited.

44. Push verifies that the source ref still resolves to the expected source object ID before contacting the remote. A mismatch returns `stale_state`.

45. Authentication, authorization, connection, and server rejection failures are differentiated when Git provides enough evidence.

46. When the connection fails after the remote may have accepted the update, push queries only the explicitly named target ref. It returns confirmed success, confirmed failure, or `network_ambiguous`; it never blindly retries.

47. A successful push returns remote name, source and target refs, old target object ID when known, new target object ID, and push mode.

### Installation, diagnostics, and routing

48. Homebrew is the only v1 distribution channel. The supported install identity is `brew install liviogama/tap/usable-git`.

49. `usable-git install --clients all` registers the same local stdio MCP server for Codex, Claude Code, Cursor Agent, and Devin CLI while preserving every unrelated client configuration entry.

50. Installation is repeatable. Matching existing entries are left valid; conflicting entries fail with a clear explanation unless the caller explicitly supplies `--force`.

51. `usable-git doctor --clients all` checks required runtimes, CLI operation behavior, MCP initialize/list/call behavior, exact tool schemas, client registration, temporary-repository publish and local-bare-remote push, and fresh-session client invocation.

52. Doctor reports each check as pass, fail, or skipped with a reason. It exits non-zero when a required check fails and never reports a client as activated without invoking it in a fresh session.

53. Agent routing prefers MCP, uses the JSON CLI only when MCP is unavailable, and falls back to scoped raw Git only for operations outside the v1 surface. It never falls back from a rejected v1 mutation to a broader raw command that bypasses the rejection.

### Privacy, measurement, and release

54. Telemetry is local and disabled by default. Enabling it is explicit and reversible.

55. Enabled semantic telemetry may retain operation, client, transport, backend, duration, Git subprocess count, result/error code, aggregate counts, component versions, and a salted repository hash.

56. Semantic telemetry never retains prompts, reasoning, patches, file contents, file names, raw paths, secrets, or command output.

57. Migrating legacy mining data writes a new redacted database and does not delete or overwrite the original database automatically.

58. Reports distinguish semantic adoption, raw fallback, repeated-read elimination, correctness, operation count, estimated Git-related tokens, latency, and client/version distribution.

59. A v1 release is blocked until automated evidence shows: 100% repository correctness and recovery, zero unrelated-work loss/corruption, 100% clean-install activation across all four clients, at least 95% semantic-tool adoption when applicable, at least 50% fewer agent-facing Git operations, and at least 30% lower Git-related tokens and p95 end-to-end time.

60. Public performance claims cite reproducible raw benchmark artifacts, trial counts, environment/runtime/Git/client versions, commit SHA, median, p95, confidence intervals, and final-state oracles. Historical prototype numbers without those artifacts are labeled historical and unverified.
