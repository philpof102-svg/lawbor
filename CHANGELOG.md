# Changelog

## Unreleased

**Nothing below is on npm.** `lawbor-bot@0.2.1` was published 2026-07-21T15:54Z from `5647185`, and that is
still what an install gets today. Measured 2026-08-13 by reading the published tree out of git rather than
downloading it: 24 commits since, touching 15 shipped files, under the same version number — so every tool
reports "up to date".

Four of them are not ordinary improvements.

- **`f521692`** — a loopback request carrying a forwarding header was treated as local, and local means it
  did not have to sign. The guard now treats it as remote.
- **`305637b`** — the read of a peer's accept-response was not capped, so a large enough response closed the
  process on OOM. `readCapped` now covers both fetch paths.
- **`c76c7ec`** — the credit-family folds were recomputed per read, an unbounded O(N)-folds-per-read CPU
  amplification. Memoized.
- **`db02e51`** — the `lawbor_validate` tool description was written as instructions to the model rather
  than a description of the tool. Hermes flagged the shape as prompt-injection-like; it is now descriptive.

And one that compounds with the gap itself: **`b5b3a20`**. The published `.claude-plugin/plugin.json`
launches with `"command": "npx", "args": ["-y", "lawbor-bot"]`. Two consequences. On Windows `npx` is a
`.cmd` shim, which does not spawn without a shell. And `npx -y lawbor-bot` **fetches the package from npm at
launch** — so even a user working from a fresh clone gets the published, stale code through the plugin path.
HEAD launches `node ${CLAUDE_PLUGIN_ROOT}/bin/lawbor-mcp.js`, which runs the files that are actually there.

The rest, in short: the admission oracle became genuinely replaceable and is now bound to gitlawb standing,
with the node pinned by IDENTITY rather than URL; a refused sender was being pointed at an oracle that had
decided nothing; the store now tells an unreadable log apart from an empty one; the job lifecycle is an
explicit state machine; and 28 green tests that nothing was running got wired into the suite.

Not a release note yet — a statement of what a release would deliver. `test/unreleased-work-is-declared.test.js`
keeps this section and the shipped tree honest with each other in both directions.

## 0.2.1 — 2026-07-21

Released from `fb1767b`: the `lawbor-try` demo with live locks, smart confirm, and delist. Published to npm
at 15:54Z, from `5647185`.

This file starts here. Entries before 0.2.1 were never written down, and this changelog does not invent
them — the git history is the record for anything older.
