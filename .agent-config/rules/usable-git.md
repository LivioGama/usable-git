---
id: usable-git
title: Usable Git Router
description: Route supported repository work through the scoped usable-git semantic API.
---

# Usable Git Router (GLOBAL RULE)

Use the `usable-git` MCP server for these exact operations when available:

- `inspect`: local repository state and change fingerprints.
- `review`: staged/unstaged evidence and bounded pagination.
- `history`: bounded local history without fetch.
- `publish`: commit an explicit file list after HEAD/fingerprint checks.
- `push`: update one configured branch using fast-forward or an exact lease.

If MCP is unavailable, use the equivalent JSON CLI:

```text
usable-git <operation> --input -
```

MCP and CLI safety rejections are terminal. Never bypass a rejected `publish` or `push` with broader raw Git commands.

Use exact-path raw Git only when the requested capability is outside the five-operation v1 surface. Preserve unrelated work, avoid broad staging, and keep history linear.

Before `publish`, obtain current HEAD and every selected change fingerprint from `inspect`. Before `push`, supply the configured remote, full source/target branch refs, expected source OID, and explicit push mode.

Never claim a performance improvement without reproducible paired artifacts containing trial counts, environment and component versions, commit SHA, success/final-state oracles, median, p95, confidence intervals, subprocess counts, agent-facing operations, and measured token data.
