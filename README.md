# usable-git - Semantic Git for Coding Agents

![Status](https://img.shields.io/badge/status-speed%20proof-1f883d)
![Runtime](https://img.shields.io/badge/runtime-Bun%201.3.14-black)
![Git](https://img.shields.io/badge/git-2.54.0-f05032)
![Benchmark](https://img.shields.io/badge/benchmark-100%20trials-blue)

<a href="https://LivioGama.github.io/agent-config/redirect.html?url=https%3A%2F%2Fraw.githubusercontent.com%2FLivioGama%2Fusable-git%2Fmain%2F.agent-config%2Frules%2Fusable-git.md"><img src="https://raw.githubusercontent.com/LivioGama/agent-config/main/assets/install-badge-small.jpg" alt="Install usable-git global rule" height="40" /></a>

### Git should be a repository API, not a transcript of shell commands.

`usable-git` is a speed proof for exposing Git to coding agents as semantic repository operations. Instead of making an agent reason through `git status`, `git add`, `git commit`, `git rev-parse`, and follow-up checks, the prototype proves that a focused repository backend can perform the same transformation directly and much faster.

## 🎯 What It Is For

Coding agents are slow and brittle when Git is only available as a CLI surface. A simple commit workflow becomes a sequence of subprocesses, text parsing, intermediate state checks, and follow-up reasoning.

`usable-git` demonstrates the opposite shape:

```text
agent intent
   ↓
publish(paths, message)
   ↓
repository transformation
   ↓
commit hash + clean state
```

The goal is not to hide Git. The goal is to expose Git as safe, structured, reversible operations that agents can call directly.

## 🏁 Result

The scoped semantic publish path is materially faster than the raw Git CLI workflow it replaces.

| Metric | Raw Git Commit | Semantic Publish | Result |
|---|---:|---:|---|
| Success rate | 100% | 100% | Tie |
| Final clean repo state | 100% | 100% | Tie |
| Median wall-clock | 18.94 ms | 0.89 ms | Semantic is 21.3x faster |
| P95 wall-clock | 22.59 ms | 1.04 ms | Semantic is 21.7x faster |
| Shell/Git processes in hot path | 2 | 0 | Semantic eliminates subprocesses |
| Agent-facing operations | 3 | 2 | Semantic reduces by 33.3% |

## 📊 Benchmark Data

Benchmark date: 2026-07-03  
Runtime: Bun 1.3.14, Git 2.54.0, macOS arm64  
Trials: 100 per scenario

### Raw Git Commit

The baseline workflow measured:

```text
write file
git add <file>
git commit -q -m <message>
```

### Semantic Publish

The semantic workflow measured:

```text
write file
publish(repoPath, message, { paths: [file] })
```

The semantic hot path does not spawn `git`. It writes the required Git data directly.

## 🏗️ How The Fast Path Works

Instead of shelling out to Git for every step:

```text
git add
git diff --cached --name-only
git commit
git rev-parse
git status
```

the fast path writes repository state directly:

```text
file content
   ↓
blob object
   ↓
tree object
   ↓
commit object
   ↓
index file + branch ref
```

That removes Git process startup, stdout/stderr parsing, and extra state-probing commands from the hot path.

## ✨ Why It Matters

- **Less latency**: the measured semantic publish path is 21.3x faster at median wall-clock time.
- **Fewer subprocesses**: the hot path uses 0 external Git processes instead of 2.
- **Less agent work**: the agent issues one semantic publish intent instead of composing multiple Git operations.
- **Cleaner API surface**: the result can return structured fields like committed files, commit hash, status, and telemetry.
- **Better direction for infrastructure**: it validates a long-lived Git service, libgit2/gitoxide backend, or jj-backed semantic repository daemon.

## 🔐 Safety Boundaries

This is a speed proof, not a complete Git replacement.

The fast path is intentionally narrow:

- explicit paths only
- root-level regular files only
- simple repositories with no existing `HEAD`
- broad staging is refused unless explicitly allowed
- unsupported cases fall back to the Git-backed implementation

Those limits are part of the point: the semantic API can choose safe, optimized paths when the repository shape is known and fall back when it is not.

## 🧪 Verification

Commands run locally against the prototype:

```sh
bun test
bun scripts/benchmark.mjs --trials 100
```

Results:

- Test suite: 7 pass, 0 fail, 61 assertions.
- Benchmark: 100/100 successful raw trials.
- Benchmark: 100/100 successful semantic trials.
- Both workflows left repositories clean in 100% of trials.
- Regression test confirms fast publish creates a valid Git commit with `0` Git subprocesses in the hot path.
- `git fsck --strict` accepts the fast-path repository.

## 🚀 Agent-First Usage

Install the global rule through the `agent-config` deeplink handler:

<a href="https://LivioGama.github.io/agent-config/redirect.html?url=https%3A%2F%2Fraw.githubusercontent.com%2FLivioGama%2Fusable-git%2Fmain%2F.agent-config%2Frules%2Fusable-git.md"><img src="https://raw.githubusercontent.com/LivioGama/agent-config/main/assets/install-badge-small.jpg" alt="Install usable-git global rule" height="40" /></a>

Raw rule URL:

```text
https://raw.githubusercontent.com/LivioGama/usable-git/main/.agent-config/rules/usable-git.md
```

Paste this repository into an agent and ask it to use the benchmark data as the target shape for a semantic Git API:

```text
Design a Git backend where agents call publish(paths, message), checkpoint(), review(), undo(), and history() instead of driving Git through shell commands. Preserve the benchmark data in README.md and expand the implementation from the scoped fast path toward a general repository service.
```

For a production implementation, the next step is to keep the semantic API and move the backend into a long-lived repository service backed by libgit2, gitoxide, jj, or a purpose-built Git object engine.
