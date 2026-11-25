# Project instructions

## Remote data and caching

- For reusable remote reads, check valid memory data first, then the permitted disk cache, and request the network only when local data is missing, expired, invalid, or insufficient. All directions of pagination, scrolling, and automatic fill use the same policy.
- Serve usable local data promptly. An explicit refresh or a live feed's freshness policy may revalidate with the source. Coalesce concurrent requests for the same data and respect the provider's cooldowns and rate limits.
- Define cache keys, account or permission scope, expiry, size limits, and cleanup when adding a cache. Keep rebuildable caches separate from workspace data, backups, and exports. Respect each source's rules for what may be persisted. For example, Feishu calendar content stays in memory. Credentials use their own protected storage.
- Authorization and remote writes are live operations. Reuse local state where applicable and confirm the outcome with the source.

## Runnable app artifact

- After every task that modifies project files, build a runnable macOS app artifact containing the completed changes before reporting the task as finished. Use `pnpm dist` unless the task establishes a more appropriate packaging command.
- Verify that the `.app` bundle was produced by the current task and exists under `release/` (normally `release/mac-arm64/All In One Workspace.app` on Apple Silicon). Do not link to a stale artifact from an earlier build.
- In the final response for every modification task, include a clearly labelled, clickable Finder link to the runnable `.app` bundle. Use the bundle's exact absolute path in a Markdown file link, for example: `[在访达中打开本次构建的 App](/absolute/path/to/release/mac-arm64/All In One Workspace.app)`.
- If a current runnable app cannot be produced, state the blocker explicitly in the final response instead of presenting an older artifact as the result.
- This requirement applies to tasks that change files. Read-only questions, reviews, and diagnostics do not require a new app build.

## Build artifact retention and worktrees

- After a modification task has packaged and verified the current version successfully, remove superseded versioned build artifacts so that the current worktree retains the current version and at most the two immediately preceding versions. Treat files belonging to one version, such as its `.dmg` and `.dmg.blockmap`, as one artifact set and keep or remove the whole set together.
- Scope cleanup to the `release/` directory beneath the current worktree root returned by `git rev-parse --show-toplevel`. Every worktree owns its own artifacts: never inspect, retain, link to, or delete build outputs in a sibling worktree, the primary checkout, or the shared Git common directory on behalf of the current worktree.
- Before cleanup, verify that the target `release/` is a real directory contained by the current worktree and is not a symlink that escapes it. If containment cannot be proven, skip deletion and report the issue.
- Run cleanup only after a successful package build and when no other packaging process is writing to that worktree's `release/`. Select explicit versioned artifact files, order versions by semantic version rather than modification time, and never use a broad recursive deletion of `release/`.
- Do not delete the current `.app` bundle, the retained version sets, or non-versioned builder metadata needed by the latest build. If a cleanup candidate is ambiguous, keep it and report it rather than risking another worktree's or version's output.
