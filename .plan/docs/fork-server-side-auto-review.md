# Server-side auto-review (fork divergence)

> **Status:** in development on branch `feature/server-side-auto-review`.
> Not yet upstreamed.

## Why this fork exists

Upstream `cline/kanban` runs auto-commit and auto-trash from the React frontend
(`web-ui/src/hooks/use-review-auto-actions.ts`). Three problems flow from that:

1. **Auto-commit does not run without a connected browser.** Tasks running on a
   remote server with auto-review enabled stall in the `review` column until a
   user reopens the kanban tab. The hook only fires when the WebSocket is
   connected and a React effect runs.
2. **Race condition with shared `baseRef`.** Two tasks sharing the same
   `baseRef` that finish around the same time both have their commit prompts
   fired simultaneously. The default commit prompt template asks the agent to
   stash → cherry-pick → stash pop into the worktree of `baseRef`. Two agents
   doing this concurrently on the same target worktree race on `.git/index.lock`,
   share stash messages, overwrite each other's index, etc. The frontend's
   `use-review-auto-actions` does not serialize by `baseRef`.
3. **Auto-trash without verifying the commit reached `baseRef`.** The frontend
   trashes when `changedFiles === 0` in the task worktree, which only proves a
   commit happened *inside the worktree*. If the cherry-pick into `baseRef`
   failed, the work is lost when the worktree is later cleaned up.

## What this fork changes

### Server-side auto-review manager (authoritative)

New module `src/server/server-auto-review-manager.ts` runs the auto-review logic
on the server. It is **always active**, regardless of whether a browser is
connected. There is exactly one place where auto-review actions are decided,
which removes any double-fire risk.

The manager hooks into:

- The workspace-metadata-monitor's polling loop for `changedFiles` /
  `headCommit` / `branch tip` updates.
- `broadcastTaskReadyForReview` in `runtime-state-hub.ts` for the initial
  registration when a task transitions into review.
- `broadcastRuntimeWorkspaceStateUpdated` for board reconciliation when tasks
  move out of review for any reason.

### Frontend becomes an observer

`web-ui/src/hooks/use-review-auto-actions.ts` no longer dispatches
`runAutoReviewGitAction` or `requestMoveTaskToTrash` automatically. It only
listens for the new WebSocket message `auto_action_pending` and triggers the
local card animation when the server announces an upcoming move.

**IMPORTANT — manual buttons stay intact.** The user can still click "Commit",
"Open PR" or "Move to Trash" on any card; those buttons keep calling the same
handlers via tRPC (`runTaskGitAction`, `requestMoveTaskToTrashWithAnimation`).
Only the *automatic* dispatch is removed.

### Verification pre-trash

Before moving a task to trash after an auto-commit, the server runs
`git rev-parse refs/heads/<baseRef>` and checks the tip moved from the baseline
captured when the task was armed. If the tip did not advance, the manager logs
`Commit NOT propagated to baseRef <X> for task <Y> — NOT trashing` and leaves
the task in review for the user to investigate.

### Serialization by baseRef

At most one task armed per `baseRef` at a time. Other tasks land in
`queueByBaseRef`. When the armed task releases the slot (commit OK, commit
failed verification, or the task left review for any reason), the next task in
the queue is processed. Tasks with different `baseRef` values continue running
in parallel.

### New WebSocket message: `auto_action_pending`

Server broadcasts this message just before initiating a programmatic move so a
connected frontend can play the card move animation locally. Schema lives in
`src/core/api-contract.ts`. Frontend handler lives in
`web-ui/src/runtime/use-runtime-state-stream.ts` and is consumed by
`use-review-auto-actions.ts`.

## Files touched (vs upstream)

**New files:**

- `src/server/server-auto-review-manager.ts`
- `src/git-actions/build-task-git-action-prompt.ts` (moved from
  `web-ui/src/git-actions/build-task-git-action-prompt.ts`)
- `src/runtime/native-agent.ts` (moved from `web-ui/src/runtime/native-agent.ts`,
  only `isNativeClineAgentSelected`)
- `.plan/docs/fork-server-side-auto-review.md` — this doc

**Modified server files:**

- `src/cli.ts` — create `autoReviewManagerRef`, pass to hub and server
- `src/core/api-contract.ts` — add `auto_action_pending` schema, wire into the
  state-stream union
- `src/server/runtime-state-hub.ts` — wire-up the manager unconditionally,
  broadcast `auto_action_pending` before triggering moves
- `src/server/runtime-server.ts` — instantiate `createServerAutoReviewManager`
  with all required dependencies, expose them
- `src/workspace/git-sync.ts` — add `getBranchTip(repoPath, baseRef)` helper
  using `child_process.spawn` with separated args (no shell)

**Modified frontend files:**

- `web-ui/src/git-actions/build-task-git-action-prompt.ts` — re-export the
  shared module
- `web-ui/src/runtime/native-agent.ts` — re-export the shared module
- `web-ui/src/hooks/use-review-auto-actions.ts` — strip auto-dispatch, keep
  only the subscriber to `auto_action_pending` for animation
- `web-ui/src/hooks/use-programmatic-card-moves.ts` — extract
  `playProgrammaticCardMoveAnimation` (animation-only path), keep the existing
  full path for manual buttons
- `web-ui/src/runtime/use-runtime-state-stream.ts` — handle the new WS message
- `web-ui/src/hooks/use-git-actions.ts` — `runAutoReviewGitAction` is no longer
  invoked from the auto-review hook; manual buttons keep using it via the same
  exports

## How to rebase against upstream

```bash
git remote add upstream https://github.com/cline/kanban.git   # one-time
git fetch upstream
git checkout feature/server-side-auto-review
git rebase upstream/main
```

Conflicts are most likely in:

- `web-ui/src/hooks/use-review-auto-actions.ts` — we deleted most of it
- `web-ui/src/hooks/use-programmatic-card-moves.ts` — we extracted a function
- `web-ui/src/hooks/use-git-actions.ts` — we use the module from a new path
- `src/core/api-contract.ts` — we added a stream message variant
- `src/server/runtime-state-hub.ts` — we hooked into broadcasts
- `src/server/runtime-server.ts` — we instantiated the manager

Conflict resolution principles:

- In `use-review-auto-actions.ts`: keep our minimal observer version. Take from
  upstream only if they add UI-only logic that doesn't dispatch actions.
- In `runtime-state-hub.ts`: keep our manager wire-up. Take upstream changes
  to anything outside the manager hooks.
- If upstream introduces an `auto_action_pending`-like message, rename ours.
- If upstream adds its own server-side auto-review module, plan to migrate to
  theirs and delete ours (see "Re-think triggers").

## Re-think triggers

Re-evaluate this fork when upstream introduces any of these changes:

- **Server-side auto-review on upstream.** If `cline/kanban` ships its own
  server-side equivalent, drop our module and adopt theirs.
- **Change in commit prompt delivery.** If `sendTaskSessionInput` /
  `sendTaskChatMessage` change signature or get replaced, adapt
  `executeAutoCommit` in the manager.
- **New `autoReviewMode`.** If they add a mode beyond `commit` / `pr` /
  `move_to_trash`, add the handler in the manager.
- **Refactor of `buildTaskGitActionPrompt`.** If the cascade of templates or
  the variable interpolation (`{{base_ref}}`, etc.) changes, update the shared
  module.
- **Schema change for `RuntimeBoardCard.autoReviewEnabled`.** If they replace
  the boolean flag with a richer state, adapt the registration logic.
- **Workspace-metadata-monitor restructure.** The manager currently consumes
  `RuntimeWorkspaceMetadata` from the monitor's `onMetadataUpdated` callback.
  If that contract changes, update the consumer.

## Tests specific to this fork

Add tests in:

- `test/server/server-auto-review-manager.test.ts` (new) — covers arm/disarm,
  baseRef serialization, pre-trash verification.
- `test/web-ui/...` — update or remove obsolete `use-review-auto-actions`
  tests.

End-to-end manual checks (run after each rebase):

- Auto-commit fires on the server with no browser connected.
- Pre-trash verification blocks when the cherry-pick into `baseRef` fails.
- Two tasks sharing `baseRef` are serialized.
- Move-to-trash animation plays in a connected browser.
- Manual Commit / Open PR / Move-to-Trash buttons still work from the card UI.

## Deployment

The remote server runs kanban via `npm install -g`. To deploy this fork:

```bash
# on the dev machine
cd /home/francisco/sandra-projects/kanban
npm run build
npm pack
# copy the resulting tarball to the server
# on the server
sudo npm uninstall -g kanban
npm install -g /tmp/kanban-<version>.tgz
# restart kanban
```

Or, for development iteration, clone the fork on the server and `npm run link`.

## PR upstream

Pending submission. If accepted, this doc and the entire fork can be retired.

## Implementation notes (2026-05-03)

- `RuntimeTaskAutoReviewMode` is `"commit" | "pr"` in v0.1.67. Upstream
  removed `"move_to_trash"` mode in commit `b5e4b2e` ("rename Trash to Done,
  add CLI aliases, remove move_to_trash auto-review"). The manager has a
  defensive `ScheduledAction` type that still accepts `"move_to_trash"` as a
  scheduled-action label (we use it internally for the post-commit trash
  step), but it does NOT branch on `entry.autoReviewMode === "move_to_trash"`.
  If the mode comes back, add a branch in `evaluate()`.
- Auto-review manager wire-up uses a lazy `autoReviewManagerRef = { current }`
  pattern: the hub captures the ref at construction time, then
  `createRuntimeServer` builds the manager (which needs the cline session
  service map living inside `createRuntimeServer`) and assigns
  `autoReviewManagerRef.current = serverAutoReviewManager`. This avoids a
  circular constructor.
- The hub's `broadcastRuntimeWorkspaceStateUpdated` now builds the snapshot
  and updates the metadata monitor + manager **even when no clients are
  connected**. Previously it early-returned if no WS clients — that broke
  server-only auto-review reconciliation.
- Tailwind oxide native binding (`@tailwindcss/oxide-linux-x64-gnu`) failed
  to install via npm optional deps once on x86_64 glibc. Workaround was
  `npm install @tailwindcss/oxide-linux-x64-gnu` directly. If you hit this
  during build, force-install the platform-specific binary.
- Build output verified: `npm run build` produces a valid `dist/cli.js` and
  `dist/web-ui/` with the new code.

## Authorship / history

- Fork created from `cline/kanban@fabf453 v0.1.67` on 2026-05-03.
- Maintainer: Francisco Quintana (`franciscoquintana` on GitHub).
- Last upstream sync: pending (fork is fresh).
