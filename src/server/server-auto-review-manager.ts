// Server-side authoritative auto-review.
//
// Replaces what `web-ui/src/hooks/use-review-auto-actions.ts` used to do:
// when a task transitions to review with `autoReviewEnabled`, send the same
// commit / pr prompt the frontend would have, and (only after verifying the
// commit landed on `baseRef`) move the task to trash.
//
// Differences vs the previous frontend behaviour:
//
//  1. **Always active.** Runs even when no browser is connected. Eliminates
//     the "tab closed, work stalls" failure mode.
//  2. **Serialised by `baseRef`.** At most one task armed per `baseRef` at a
//     time. Others wait in `queueByBaseRef`. Prevents two agents fighting
//     over the same target worktree (`.git/index.lock`, stash collisions).
//  3. **Verification before trash.** After a commit looks done in the task
//     worktree (`changedFiles === 0`), we re-read the tip of `refs/heads/<baseRef>`
//     and only trash when it differs from the baseline captured at arming time.
//     If the cherry-pick failed and `baseRef` did not advance, the task stays
//     in review.
//
// Manual UI buttons (Commit / Open PR / Move to Trash) still go through the
// existing tRPC paths in the web-ui — only the *automatic* dispatch lives here.
//
// See `.plan/docs/fork-server-side-auto-review.md`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service.js";
import type {
	RuntimeBoardData,
	RuntimeConfigResponse,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskWorkspaceInfoResponse,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract.js";
import { moveTaskToColumn, trashTaskAndGetReadyLinkedTaskIds } from "../core/task-board-mutations.js";
import { buildTaskGitActionPrompt, type TaskGitAction } from "../git-actions/build-task-git-action-prompt.js";
import { isNativeClineAgentSelected } from "../runtime/native-agent.js";
import { loadWorkspaceBoardById, mutateWorkspaceState } from "../state/workspace-state.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { countCommitsAheadOfBaseRef, getBranchTip, isCardCommitInBaseRefRange } from "../workspace/git-sync.js";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree.js";
import { logError, logInfo, logWarn } from "./server-log.js";
import { BG_ACTIVE_FILE_NAME, NEEDS_INPUT_FILE_NAME } from "./two-phase.js";

const ACTION_DEBOUNCE_MS = 500;

type ScheduledAction = "commit" | "pr" | "move_to_trash";

// Persisted on the board card so the in-memory `armed` state survives a
// kanban restart. The card-side shape matches `autoReviewArmState` on
// `runtimeBoardCardSchema`. See `.plan/docs/fork-server-side-auto-review.md`.
interface PersistedArmState {
	at: number;
	baseRefTipAtArm: string | null;
	headCommitAtArm: string | null;
	mode: RuntimeTaskAutoReviewMode;
}
// Microsleep we yield before doing the actual move-to-trash mutation, to give
// connected frontends time to start the local move animation (after we've
// emitted the `auto_action_pending` broadcast). Empirical: 80ms is enough on
// localhost and remote SSH+tunnel without being noticeable.
const MOVE_ANIMATION_GRACE_MS = 80;
// How long, after arming, we keep re-checking baseRef advancement before
// concluding the commit didn't propagate. The agent typically does
// `git commit` (drops changedFiles to 0) seconds before `git cherry-pick`
// onto baseRef finishes — without this grace window we'd disarm too early
// and the card would stay in review even though baseRef eventually advances.
//
// This also gates how long the `inFlightByBaseRef` slot is held during the
// cherry-pick. While the slot is held, NO OTHER task on the same baseRef
// can have its commit prompt fired (they wait in `queueByBaseRef`). Be
// generous: a stuck or slow agent disarming early would release the slot,
// the next queued task would fire its prompt, and we'd end up with two
// agents fighting over the same target worktree on cherry-pick.
const VERIFICATION_GRACE_PERIOD_MS = 3_600_000;
// Backoff between re-checks of baseRef tip during the grace period.
const VERIFICATION_RECHECK_INTERVAL_MS = 5_000;
// Window after `registerTaskForAutoReview` during which an unarmed
// entry is NOT dropped when the card leaves the review column. The
// auto-memory subagent that openclaude (and similar derivatives) runs
// post-Stop fires PreToolUse / PostToolUse in the same millisecond
// the card lands in review — without this grace the entry is
// unregistered before `evaluate` can run, so the commit prompt never
// dispatches and cards that the executor self-committed never reach
// trash. The grace is enforced even after `unregisterTask` is logged
// downstream — the entry stays in `pendingByTaskId` and the next
// metadata tick (or the next time the card re-enters review)
// re-runs `evaluate` against it.
const UNARMED_DROP_GRACE_MS = 15_000;

interface PendingEntry {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	baseRef: string;
	autoReviewMode: RuntimeTaskAutoReviewMode;
	armed: boolean;
	armedAt: number | null;
	baseRefTipAtArm: string | null;
	headCommitAtArm: string | null;
	scheduledAction: ScheduledAction | null;
	actionTimer: NodeJS.Timeout | null;
	moveToTrashInFlight: boolean;
	// True if `armed` was restored from a persisted arm record at register
	// time (kanban-restart recovery). The original commit prompt was
	// dispatched to a PTY that may no longer be alive — when evaluate sees
	// changedFiles>0 we must re-dispatch instead of waiting forever for the
	// agent to act on a prompt it never received.
	armedFromRehydrate: boolean;
	// Wall-clock when this entry was created. Used by
	// `onWorkspaceStateUpdated` to grant a grace window before dropping
	// an unarmed entry that the card has just moved out of review,
	// because the agent's post-Stop tool activity (openclaude
	// auto-memory subagent in particular) can flip the card review →
	// in_progress in the same millisecond that the auto-review entry is
	// being registered, leaving evaluate without a chance to arm.
	registeredAt: number;
	// Last column the card was observed in. Lets us:
	//   1. Keep an armed entry alive when the agent reactivates and the
	//      to_in_progress hook moves the card review → in_progress mid-commit.
	//   2. Emit the right `fromColumnId` on the auto_action_pending broadcast
	//      so the move-to-trash animation comes from the card's actual column.
	currentColumnId: "review" | "in_progress" | null;
	// Re-check timer used by the verification grace window. Separate from
	// `actionTimer` (commit/PR/trash debounce) so the two don't conflict.
	verificationRecheckTimer: NodeJS.Timeout | null;
}

export interface AutoActionPendingPayload {
	workspaceId: string;
	taskId: string;
	fromColumnId: "review" | "in_progress";
	action: "move_to_trash" | "move_to_review" | "move_to_in_progress";
}

export interface CreateServerAutoReviewManagerDependencies {
	getTerminalManagerForWorkspace: (workspaceId: string) => TerminalSessionManager | null;
	getClineTaskSessionServiceForWorkspace: (workspaceId: string) => ClineTaskSessionService | null;
	getRuntimeConfigForWorkspace: (workspaceId: string) => Promise<RuntimeConfigResponse>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastAutoActionPending: (payload: AutoActionPendingPayload) => void;
	// Bumps the workspace-metadata-monitor's subscriber count so it polls
	// `git status` even when no browser is connected. Without this, the
	// monitor only polls while a client is subscribed, which means
	// `onWorkspaceMetadataUpdated` never fires and auto-commit can never
	// trigger server-side. The manager balances each subscribe with an
	// unsubscribe when it has no more pending tasks for that workspace.
	subscribeWorkspaceMetadataMonitor: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	unsubscribeWorkspaceMetadataMonitor: (workspaceId: string) => void;
	// Synchronous read of the monitor's last cached snapshot for a workspace.
	// Returns null when the monitor has no entry for that workspace yet (e.g.
	// before the first refresh). Used to seed the manager's per-task cache at
	// register time so `evaluate` can fire immediately even when the polled
	// snapshot is stable (and therefore not emitting `onMetadataUpdated`).
	getCurrentWorkspaceMetadata: (workspaceId: string) => RuntimeWorkspaceMetadata | null;
	// Auto-start a linked backlog task that became ready after a prerequisite
	// was trashed. Mirrors what `kanban task done` does for `readyTaskIds`:
	// ensure the task's worktree, spawn its agent process, and move the card
	// from `backlog` to `in_progress`. Without this, linked tasks freed by an
	// auto-trash sit in `in_progress` (or wherever they land) without an
	// active agent — the user complaint that drove this hookup.
	autoStartLinkedReadyTask: (workspaceId: string, workspacePath: string, taskId: string) => Promise<void>;
}

export interface RegisterTaskForAutoReviewParams {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	baseRef: string;
	autoReviewMode: RuntimeTaskAutoReviewMode;
	// Optional arm state to rehydrate from the persisted card. When present,
	// the entry starts as `armed=true` and the verification path runs from
	// the next evaluate (no fresh commit prompt is dispatched). Lets the
	// manager finish trashing a card whose commit landed across a restart.
	persistedArmState?: PersistedArmState | null;
}

export interface ServerAutoReviewManager {
	registerTaskForAutoReview(params: RegisterTaskForAutoReviewParams): void;
	moveTaskInProgressToReview(workspaceId: string, workspacePath: string, taskId: string): Promise<void>;
	moveTaskReviewToInProgress(workspaceId: string, workspacePath: string, taskId: string): Promise<void>;
	moveInterruptedTaskToTrash(workspaceId: string, workspacePath: string, taskId: string): Promise<void>;
	onWorkspaceMetadataUpdated(workspaceId: string, metadata: RuntimeWorkspaceMetadata): void;
	onWorkspaceStateUpdated(workspaceId: string, workspacePath: string, board: RuntimeBoardData): void;
	close(): void;
}

function logTag(taskId: string, baseRef: string): string {
	return `[ServerAutoReview task=${taskId} baseRef=${baseRef}]`;
}

function metadataToWorkspaceInfo(meta: RuntimeTaskWorkspaceMetadata): RuntimeTaskWorkspaceInfoResponse {
	return {
		taskId: meta.taskId,
		path: meta.path,
		exists: meta.exists,
		baseRef: meta.baseRef,
		branch: meta.branch,
		isDetached: meta.isDetached,
		headCommit: meta.headCommit,
	};
}

export function createServerAutoReviewManager(
	deps: CreateServerAutoReviewManagerDependencies,
): ServerAutoReviewManager {
	const pendingByTaskId = new Map<string, PendingEntry>();
	// Latest known metadata snapshot per task — used at execute time so we read
	// the most recent values rather than the snapshot from when we scheduled.
	const latestMetadataByTaskId = new Map<string, RuntimeTaskWorkspaceMetadata>();
	// Serialisation slots:
	const inFlightByBaseRef = new Map<string, string>(); // baseRef -> taskId
	const queueByBaseRef = new Map<string, string[]>(); // baseRef -> [taskIds]
	// Per-workspace count of pending entries. Used to subscribe / unsubscribe
	// the metadata monitor so it keeps polling git status even when no
	// browser is connected. Each entry is one task currently armed-or-pending.
	const subscriptionCountByWorkspaceId = new Map<string, number>();
	const subscribedWorkspacePaths = new Map<string, string>();

	function acquireMetadataSubscription(workspaceId: string, workspacePath: string): void {
		const previous = subscriptionCountByWorkspaceId.get(workspaceId) ?? 0;
		subscriptionCountByWorkspaceId.set(workspaceId, previous + 1);
		subscribedWorkspacePaths.set(workspaceId, workspacePath);
		if (previous === 0) {
			void Promise.resolve(deps.subscribeWorkspaceMetadataMonitor(workspaceId, workspacePath)).catch((err) => {
				logError(`[ServerAutoReview] subscribe metadata monitor failed for ${workspaceId}`, err);
			});
		}
	}

	function releaseMetadataSubscription(workspaceId: string): void {
		const previous = subscriptionCountByWorkspaceId.get(workspaceId) ?? 0;
		const next = Math.max(0, previous - 1);
		if (next === 0) {
			subscriptionCountByWorkspaceId.delete(workspaceId);
			subscribedWorkspacePaths.delete(workspaceId);
			deps.unsubscribeWorkspaceMetadataMonitor(workspaceId);
		} else {
			subscriptionCountByWorkspaceId.set(workspaceId, next);
		}
	}

	function clearTimer(entry: PendingEntry): void {
		if (entry.actionTimer !== null) {
			clearTimeout(entry.actionTimer);
			entry.actionTimer = null;
			entry.scheduledAction = null;
		}
	}

	function clearVerificationRecheck(entry: PendingEntry): void {
		if (entry.verificationRecheckTimer !== null) {
			clearTimeout(entry.verificationRecheckTimer);
			entry.verificationRecheckTimer = null;
		}
	}

	function scheduleAction(entry: PendingEntry, action: ScheduledAction, run: () => void): void {
		if (entry.actionTimer !== null && entry.scheduledAction === action) {
			return;
		}
		clearTimer(entry);
		entry.scheduledAction = action;
		const timer = setTimeout(() => {
			entry.actionTimer = null;
			entry.scheduledAction = null;
			// Defensive: there is a race where the timer fires before
			// `clearTimer` (called from `onWorkspaceStateUpdated`'s unregister
			// branch) gets a chance to cancel it. Symptoms: the closure keeps
			// `entry` alive even after it was removed from `pendingByTaskId`,
			// so `run()` would paste a stale commit prompt to the agent while
			// a NEW entry for the same task is also scheduling its own arm
			// → two commit prompts back-to-back. Skip silently and clean up
			// any slot we may still hold so the legitimate replacement entry
			// can proceed unblocked.
			if (pendingByTaskId.get(entry.taskId) !== entry) {
				if (inFlightByBaseRef.get(entry.baseRef) === entry.taskId) {
					releaseSlot(entry.baseRef, entry.taskId);
				}
				return;
			}
			run();
		}, ACTION_DEBOUNCE_MS);
		// Don't keep the process alive if this is the only thing pending.
		timer.unref?.();
		entry.actionTimer = timer;
	}

	function enqueue(baseRef: string, taskId: string): void {
		const queue = queueByBaseRef.get(baseRef) ?? [];
		if (!queue.includes(taskId)) {
			queue.push(taskId);
			queueByBaseRef.set(baseRef, queue);
			logInfo(`${logTag(taskId, baseRef)} queued behind ${inFlightByBaseRef.get(baseRef)}`);
		}
	}

	function releaseSlot(baseRef: string, taskId: string): void {
		if (inFlightByBaseRef.get(baseRef) === taskId) {
			inFlightByBaseRef.delete(baseRef);
		}
		const queue = queueByBaseRef.get(baseRef);
		if (!queue || queue.length === 0) {
			queueByBaseRef.delete(baseRef);
			return;
		}
		const nextTaskId = queue.shift();
		if (nextTaskId === undefined) {
			queueByBaseRef.delete(baseRef);
			return;
		}
		if (queue.length === 0) {
			queueByBaseRef.delete(baseRef);
		} else {
			queueByBaseRef.set(baseRef, queue);
		}
		const nextEntry = pendingByTaskId.get(nextTaskId);
		if (nextEntry) {
			logInfo(`${logTag(nextTaskId, baseRef)} dequeued, evaluating`);
			void evaluate(nextEntry).catch((err) => {
				logError(`${logTag(nextTaskId, baseRef)} evaluate after dequeue failed:`, err);
			});
		}
	}

	async function setCardAutoReviewLastError(
		workspacePath: string,
		taskId: string,
		error: { at: number; reason: string } | null,
	): Promise<void> {
		try {
			const result = await mutateWorkspaceState<{ updated: boolean }>(workspacePath, (latestState) => {
				let updated = false;
				const columns = latestState.board.columns.map((column) => {
					const cards = column.cards.map((card) => {
						if (card.id !== taskId) {
							return card;
						}
						const current = card.autoReviewLastError ?? null;
						if (current === error || (current !== null && error !== null && current.at === error.at)) {
							return card;
						}
						updated = true;
						return { ...card, autoReviewLastError: error };
					});
					return updated && cards !== column.cards ? { ...column, cards } : column;
				});
				if (!updated) {
					return { board: latestState.board, value: { updated: false }, save: false };
				}
				const nextBoard = { ...latestState.board, columns };
				const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: nextBoard };
				return { board: nextState.board, value: { updated: true } };
			});
			if (result.saved) {
				// Surface the change to any connected frontend so it can render
				// the warning marker without a manual refresh.
				const workspaceId = pendingByTaskId.get(taskId)?.workspaceId;
				if (workspaceId) {
					void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				}
			}
		} catch (err) {
			logError(`[ServerAutoReview] setCardAutoReviewLastError(${taskId}) failed:`, err);
		}
	}

	async function setCardAutoReviewArmState(
		workspacePath: string,
		taskId: string,
		armState: PersistedArmState | null,
	): Promise<void> {
		try {
			await mutateWorkspaceState<{ updated: boolean }>(workspacePath, (latestState) => {
				let updated = false;
				const columns = latestState.board.columns.map((column) => {
					const cards = column.cards.map((card) => {
						if (card.id !== taskId) {
							return card;
						}
						const current = card.autoReviewArmState ?? null;
						const same =
							(current === null && armState === null) ||
							(current !== null &&
								armState !== null &&
								current.at === armState.at &&
								current.baseRefTipAtArm === armState.baseRefTipAtArm &&
								current.headCommitAtArm === armState.headCommitAtArm &&
								current.mode === armState.mode);
						if (same) {
							return card;
						}
						updated = true;
						return { ...card, autoReviewArmState: armState };
					});
					return updated && cards !== column.cards ? { ...column, cards } : column;
				});
				if (!updated) {
					return { board: latestState.board, value: { updated: false }, save: false };
				}
				const nextBoard = { ...latestState.board, columns };
				const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: nextBoard };
				return { board: nextState.board, value: { updated: true } };
			});
		} catch (err) {
			logError(`[ServerAutoReview] setCardAutoReviewArmState(${taskId}) failed:`, err);
		}
	}

	async function executeCommitOrPr(entry: PendingEntry): Promise<void> {
		const meta = latestMetadataByTaskId.get(entry.taskId);
		if (!meta) {
			logWarn(`${logTag(entry.taskId, entry.baseRef)} no metadata available, skipping commit`);
			return;
		}

		// Clear any prior auto-review error before this fresh attempt; if it
		// fails again `disarmWithoutTrash` will set a new one.
		await setCardAutoReviewLastError(entry.workspacePath, entry.taskId, null);

		// Capture baselines BEFORE sending the prompt so the verification later
		// is faithful (the agent might commit very quickly).
		const baseRefTip = await getBranchTip(entry.workspacePath, entry.baseRef);
		entry.baseRefTipAtArm = baseRefTip;
		entry.headCommitAtArm = meta.headCommit;
		entry.armed = true;
		entry.armedAt = Date.now();

		// Persist arm state on the card so a kanban restart can rehydrate the
		// in-memory `armed` flag and finish the verification/trash flow even
		// if the agent is mid-cherry-pick when the server dies.
		await setCardAutoReviewArmState(entry.workspacePath, entry.taskId, {
			at: entry.armedAt,
			baseRefTipAtArm: entry.baseRefTipAtArm,
			headCommitAtArm: entry.headCommitAtArm,
			mode: entry.autoReviewMode,
		});

		const config = await deps.getRuntimeConfigForWorkspace(entry.workspaceId);
		const action: TaskGitAction = entry.autoReviewMode === "pr" ? "pr" : "commit";
		const prompt = buildTaskGitActionPrompt({
			action,
			workspaceInfo: metadataToWorkspaceInfo(meta),
			templates: {
				commitPromptTemplate: config.commitPromptTemplate,
				openPrPromptTemplate: config.openPrPromptTemplate,
				commitPromptTemplateDefault: config.commitPromptTemplateDefault,
				openPrPromptTemplateDefault: config.openPrPromptTemplateDefault,
			},
		});

		logInfo(
			`${logTag(entry.taskId, entry.baseRef)} sending ${action} prompt (baseRef tip @ arm = ${baseRefTip ?? "<none>"})`,
		);

		try {
			if (isNativeClineAgentSelected(config.selectedAgentId)) {
				const clineService = deps.getClineTaskSessionServiceForWorkspace(entry.workspaceId);
				if (!clineService) {
					throw new Error("cline task session service unavailable");
				}
				const result = await clineService.sendTaskSessionInput(entry.taskId, prompt, "act");
				if (!result) {
					throw new Error("cline service refused the input (no session?)");
				}
			} else {
				const terminalManager = deps.getTerminalManagerForWorkspace(entry.workspaceId);
				if (!terminalManager) {
					throw new Error("terminal manager unavailable for workspace");
				}
				// Mirror exactly what `web-ui/src/hooks/use-git-actions.ts` did
				// before the server-side migration: paste the prompt wrapped
				// in bracketed-paste markers (no trailing `\r`), wait ~200 ms,
				// then send a separate `\r` to submit. Splitting the two
				// writes matters: claude's TUI consumes the `\r` adjacent to
				// `\e[201~` as part of the paste-close handling, so a combined
				// sequence pastes but never submits — which is what we
				// observed (prompt arrives, no Enter, claude stays idle).
				const pasted = terminalManager.writeInput(entry.taskId, Buffer.from(`[200~${prompt}[201~`, "utf8"));
				if (!pasted) {
					throw new Error("terminal session not running");
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 200));
				terminalManager.writeInput(entry.taskId, Buffer.from("\r", "utf8"));
			}
		} catch (err) {
			logError(`${logTag(entry.taskId, entry.baseRef)} dispatch failed, disarming:`, err);
			entry.armed = false;
			entry.armedAt = null;
			entry.baseRefTipAtArm = null;
			entry.headCommitAtArm = null;
			releaseSlot(entry.baseRef, entry.taskId);
		}
	}

	async function executeMoveToTrash(entry: PendingEntry): Promise<void> {
		if (entry.moveToTrashInFlight) {
			return;
		}
		entry.moveToTrashInFlight = true;
		try {
			deps.broadcastAutoActionPending({
				workspaceId: entry.workspaceId,
				taskId: entry.taskId,
				fromColumnId: entry.currentColumnId ?? "review",
				action: "move_to_trash",
			});
			// Yield briefly so any connected frontend can start its local
			// move animation before our state mutation broadcast lands.
			await new Promise<void>((resolve) => setTimeout(resolve, MOVE_ANIMATION_GRACE_MS));

			const mutation = await mutateWorkspaceState<{ moved: boolean; readyTaskIds: string[] }>(
				entry.workspacePath,
				(latestState) => {
					const trashed = trashTaskAndGetReadyLinkedTaskIds(latestState.board, entry.taskId);
					if (!trashed.moved) {
						return { board: latestState.board, value: { moved: false, readyTaskIds: [] }, save: false };
					}
					const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: trashed.board };
					return { board: nextState.board, value: { moved: true, readyTaskIds: trashed.readyTaskIds } };
				},
			);

			if (mutation.saved) {
				logInfo(`${logTag(entry.taskId, entry.baseRef)} moved to trash`);
				const terminalManager = deps.getTerminalManagerForWorkspace(entry.workspaceId);
				terminalManager?.stopTaskSession(entry.taskId);
				void deps.broadcastRuntimeWorkspaceStateUpdated(entry.workspaceId, entry.workspacePath);
				// Auto-start any linked backlog tasks the trash just unblocked.
				// Mirrors what `kanban task done` does in `commands/task.ts:trashTask`.
				const readyTaskIds = mutation.value?.readyTaskIds ?? [];
				for (const readyTaskId of readyTaskIds) {
					try {
						await deps.autoStartLinkedReadyTask(entry.workspaceId, entry.workspacePath, readyTaskId);
						logInfo(`${logTag(entry.taskId, entry.baseRef)} auto-started linked task ${readyTaskId}`);
					} catch (startErr) {
						logError(
							`${logTag(entry.taskId, entry.baseRef)} failed to auto-start linked task ${readyTaskId}:`,
							startErr,
						);
					}
				}
			} else {
				logInfo(`${logTag(entry.taskId, entry.baseRef)} already gone from review, nothing to trash`);
			}
		} catch (err) {
			logError(`${logTag(entry.taskId, entry.baseRef)} move-to-trash failed:`, err);
		} finally {
			clearVerificationRecheck(entry);
			pendingByTaskId.delete(entry.taskId);
			latestMetadataByTaskId.delete(entry.taskId);
			releaseSlot(entry.baseRef, entry.taskId);
			releaseMetadataSubscription(entry.workspaceId);
			entry.moveToTrashInFlight = false;
		}
	}

	function disarmWithoutTrash(entry: PendingEntry, reason: string): void {
		logInfo(`${logTag(entry.taskId, entry.baseRef)} disarming without trash: ${reason}`);
		entry.armed = false;
		entry.armedAt = null;
		entry.baseRefTipAtArm = null;
		entry.headCommitAtArm = null;
		clearTimer(entry);
		clearVerificationRecheck(entry);
		releaseSlot(entry.baseRef, entry.taskId);
		// Persist the failure on the card so the UI can surface it. Fire and
		// forget — the card's `autoReviewLastError` becomes the visible
		// breadcrumb even after kanban restarts. Cleared on the next arm.
		void setCardAutoReviewLastError(entry.workspacePath, entry.taskId, {
			at: Date.now(),
			reason: `Auto-${entry.autoReviewMode === "pr" ? "PR" : "commit"} failed: ${reason}`,
		});
		// Drop the persisted arm state — a future register should start fresh
		// instead of rehydrating into the failed run.
		void setCardAutoReviewArmState(entry.workspacePath, entry.taskId, null);
	}

	async function evaluate(entry: PendingEntry): Promise<void> {
		const meta = latestMetadataByTaskId.get(entry.taskId);
		const changed = meta?.changedFiles ?? null;

		// Orphan detection: when a card is trashed via CLI/UI while its
		// auto-review entry is mid-oscillation, the worktree gets cleaned up
		// but the entry can survive in `pendingByTaskId` (the trash command
		// can race with hooks-api re-registering the task on the next Stop
		// from the still-running executor PTY). Once the worktree is gone
		// the entry will never make forward progress — changedFiles cannot
		// be sampled and baseRef verification has no commit to point at —
		// so it bounces review↔in_progress forever, blocking baseRef slots
		// and confusing the UI. Detect "worktree gone" up front and unregister.
		try {
			const orphanPathInfo = await getTaskWorkspacePathInfo({
				cwd: entry.workspacePath,
				taskId: entry.taskId,
				baseRef: entry.baseRef,
			});
			if (!orphanPathInfo.exists) {
				logInfo(
					`${logTag(entry.taskId, entry.baseRef)} worktree missing on disk — entry is orphaned, unregistering`,
				);
				clearTimer(entry);
				clearVerificationRecheck(entry);
				pendingByTaskId.delete(entry.taskId);
				latestMetadataByTaskId.delete(entry.taskId);
				releaseSlot(entry.baseRef, entry.taskId);
				releaseMetadataSubscription(entry.workspaceId);
				// Mark the (now stale) session as interrupted so the rest of
				// the runtime stops resurrecting the in_progress column from
				// hook events emitted by the long-dead PTY.
				const terminalManager = deps.getTerminalManagerForWorkspace(entry.workspaceId);
				const stale = terminalManager?.getSummary(entry.taskId);
				if (stale && stale.state !== "interrupted") {
					try {
						terminalManager?.stopTaskSession(entry.taskId);
					} catch {
						// Best effort: state will reconcile on the next stop hook.
					}
				}
				return;
			}
		} catch {
			// Best effort: if path resolution fails, fall through to the
			// normal evaluation flow rather than blocking auto-review.
		}

		// P2 — skip arming while the planner of a two-phase card is the active
		// agent. The planner runs in plan mode and cannot stage or commit
		// anything; if the planner's Stop hook armed auto-review, the commit
		// prompt would hit a soon-to-exit PTY and either be lost or push a
		// non-commit message into the planner's last turn. The executor will
		// re-register the task once it spawns and emits its own Stop.
		try {
			const board = await loadWorkspaceBoardById(entry.workspaceId);
			const card = board?.columns.flatMap((column) => column.cards).find((c) => c.id === entry.taskId);
			if (card?.planAgentId) {
				const terminalManagerForPhase = deps.getTerminalManagerForWorkspace(entry.workspaceId);
				const currentAgentId = terminalManagerForPhase?.getSummary(entry.taskId)?.agentId ?? null;
				if (currentAgentId === card.planAgentId) {
					logInfo(
						`${logTag(entry.taskId, entry.baseRef)} active agent is the planner (${currentAgentId}) — deferring auto-review until executor takes over`,
					);
					clearTimer(entry);
					return;
				}
			}
		} catch {
			// Best effort: if the board lookup fails fall through to the
			// normal evaluation flow. Worst case is the upstream behaviour.
		}

		// Honor the `.kanban-needs-input` sentinel. When the executor agent
		// asks the user a question it cannot safely answer on its own, it
		// writes this file to the worktree root before ending its turn.
		// Auto-review must NOT inject its commit prompt while the file
		// exists — that would override the question and ship a default
		// decision. The agent removes the sentinel when the user responds.
		try {
			const pathInfo = await getTaskWorkspacePathInfo({
				cwd: entry.workspacePath,
				taskId: entry.taskId,
				baseRef: entry.baseRef,
			});
			if (pathInfo.exists && existsSync(join(pathInfo.path, NEEDS_INPUT_FILE_NAME))) {
				logInfo(
					`${logTag(entry.taskId, entry.baseRef)} agent signaled ${NEEDS_INPUT_FILE_NAME} — skipping auto-review until user replies`,
				);
				clearTimer(entry);
				return;
			}
			// Same gate for the background-task sentinel: the agent kicked
			// off a `&`/`nohup` subprocess and reported its turn as "done"
			// but the subprocess is still working. Don't arm or fire the
			// commit prompt; wait for the agent to remove the sentinel and
			// emit another Stop.
			if (pathInfo.exists && existsSync(join(pathInfo.path, BG_ACTIVE_FILE_NAME))) {
				logInfo(
					`${logTag(entry.taskId, entry.baseRef)} agent signaled ${BG_ACTIVE_FILE_NAME} — background subprocess still active, skipping auto-review`,
				);
				clearTimer(entry);
				return;
			}
		} catch {
			// Best effort: if path resolution fails, fall through to the
			// normal arming flow instead of blocking auto-review.
		}

		// `RuntimeTaskAutoReviewMode` is `"commit" | "pr"` in v0.1.67. The
		// historical `"move_to_trash"` mode was removed upstream in commit
		// b5e4b2e ("remove move_to_trash auto-review"). If they ever bring
		// back a "skip-commit" trash mode, branch on it here.
		if (entry.armed) {
			if (changed === null || changed > 0) {
				// Special case: rehydrated armed entries assume the original
				// commit prompt is still in flight, but if the PTY was killed
				// during the kanban restart the agent never received it.
				// Detection: armedFromRehydrate is still set (we never sent
				// a fresh prompt this lifetime) AND there are uncommitted
				// changes (agent never acted on the supposed prompt). In
				// that case demote to not-armed so the dispatch flow below
				// re-sends the prompt to the live PTY.
				if (entry.armedFromRehydrate && changed !== null && changed > 0) {
					logInfo(
						`${logTag(entry.taskId, entry.baseRef)} rehydrated as armed but worktree still has ${changed} uncommitted file(s) — the prompt likely went to a dead PTY; re-dispatching`,
					);
					entry.armed = false;
					entry.armedAt = null;
					entry.armedFromRehydrate = false;
					// Fall through to the arming/dispatch flow below.
				} else {
					// Still working. Don't decide yet.
					clearTimer(entry);
					return;
				}
			} else {
				// changedFiles === 0 → either commit succeeded and propagated, or
				// the agent discarded the changes without committing onto baseRef.
				// Verify by re-reading the baseRef tip.
				const tipNow = await getBranchTip(entry.workspacePath, entry.baseRef);
				if (entry.baseRefTipAtArm === null || tipNow === null) {
					disarmWithoutTrash(
						entry,
						`could not verify baseRef advance (atArm=${entry.baseRefTipAtArm ?? "null"}, now=${tipNow ?? "null"})`,
					);
					return;
				}
				if (tipNow === entry.baseRefTipAtArm) {
					// The local commit landed (changedFiles === 0) but the
					// cherry-pick onto baseRef hasn't bumped the branch tip yet.
					// Usually that means the agent is still mid-cherry-pick — they
					// run `git commit` first and only after that `git -C P cherry-pick`,
					// so this branch fires within seconds of `git commit`. Give it a
					// grace window before concluding the work was lost.
					const elapsedSinceArm = entry.armedAt === null ? Number.POSITIVE_INFINITY : Date.now() - entry.armedAt;
					if (elapsedSinceArm < VERIFICATION_GRACE_PERIOD_MS) {
						// Schedule a recheck unless one is already pending.
						if (entry.verificationRecheckTimer === null) {
							const remaining = Math.max(0, VERIFICATION_GRACE_PERIOD_MS - elapsedSinceArm);
							const recheckDelay = Math.min(VERIFICATION_RECHECK_INTERVAL_MS, remaining);
							logInfo(
								`${logTag(entry.taskId, entry.baseRef)} baseRef still at ${entry.baseRefTipAtArm}; cherry-pick may be in flight, rechecking in ${recheckDelay}ms (grace=${Math.round(remaining / 1000)}s left)`,
							);
							const timer = setTimeout(() => {
								entry.verificationRecheckTimer = null;
								// Re-evaluate only if the entry is still the live one
								// (the same defensive check we have in scheduleAction).
								if (pendingByTaskId.get(entry.taskId) !== entry) {
									return;
								}
								if (!entry.armed) {
									return;
								}
								void evaluate(entry).catch((err) => {
									logError(`${logTag(entry.taskId, entry.baseRef)} verification recheck failed:`, err);
								});
							}, recheckDelay);
							timer.unref?.();
							entry.verificationRecheckTimer = timer;
						}
						return;
					}
					disarmWithoutTrash(
						entry,
						`baseRef tip did not advance (${entry.baseRefTipAtArm}) within ${VERIFICATION_GRACE_PERIOD_MS / 1000}s. Commit was NOT propagated to ${entry.baseRef}.`,
					);
					return;
				}
				// Cross-card false-positive guard: the tip moved, but it may have
				// moved because of a SIBLING card's cherry-pick on the same baseRef
				// rather than our own. Without this check, the 2026-06-07 incident
				// loses the still-pending card's commit (orphan in git, gone from
				// the board). Verify our card's commit actually appears in the
				// `(baseRefTipAtArm, tipNow]` range by subject — cherry-pick
				// preserves the subject by default. Treat a `null` return
				// (helper couldn't read git) as "can't verify, fall through to
				// the grace-recheck path"; a `false` return is the definitive
				// "sibling card cherry-picked first, our commit hasn't landed
				// yet — keep waiting".
				let cardCommitLandedInRange: boolean | null = null;
				try {
					const cardPathInfo = await getTaskWorkspacePathInfo({
						cwd: entry.workspacePath,
						taskId: entry.taskId,
						baseRef: entry.baseRef,
					});
					if (cardPathInfo.exists) {
						cardCommitLandedInRange = await isCardCommitInBaseRefRange({
							cardWorktreePath: cardPathInfo.path,
							baseRefRepoPath: entry.workspacePath,
							baseRefTipAtArm: entry.baseRefTipAtArm,
							tipNow,
						});
					}
				} catch {
					cardCommitLandedInRange = null;
				}
				if (cardCommitLandedInRange === false) {
					const elapsedSinceArm = entry.armedAt === null ? Number.POSITIVE_INFINITY : Date.now() - entry.armedAt;
					if (elapsedSinceArm < VERIFICATION_GRACE_PERIOD_MS) {
						if (entry.verificationRecheckTimer === null) {
							const remaining = Math.max(0, VERIFICATION_GRACE_PERIOD_MS - elapsedSinceArm);
							const recheckDelay = Math.min(VERIFICATION_RECHECK_INTERVAL_MS, remaining);
							logInfo(
								`${logTag(entry.taskId, entry.baseRef)} baseRef advanced ${entry.baseRefTipAtArm} → ${tipNow} but our card's commit subject is not in the range — sibling card cherry-picked first, waiting ${recheckDelay}ms (grace=${Math.round(remaining / 1000)}s left)`,
							);
							const timer = setTimeout(() => {
								entry.verificationRecheckTimer = null;
								if (pendingByTaskId.get(entry.taskId) !== entry) return;
								if (!entry.armed) return;
								void evaluate(entry).catch((err) => {
									logError(`${logTag(entry.taskId, entry.baseRef)} verification recheck failed:`, err);
								});
							}, recheckDelay);
							timer.unref?.();
							entry.verificationRecheckTimer = timer;
						}
						return;
					}
					disarmWithoutTrash(
						entry,
						`baseRef advanced ${entry.baseRefTipAtArm} → ${tipNow} but our card's commit subject never appeared in the range within ${VERIFICATION_GRACE_PERIOD_MS / 1000}s. A sibling card cherry-picked first; our commit may be orphaned in the worktree.`,
					);
					return;
				}
				logInfo(
					`${logTag(entry.taskId, entry.baseRef)} baseRef advanced ${entry.baseRefTipAtArm} → ${tipNow}${cardCommitLandedInRange === true ? " (card subject confirmed in range)" : " (subject check inconclusive)"}, scheduling trash`,
				);
				scheduleAction(entry, "move_to_trash", () => {
					void executeMoveToTrash(entry);
				});
				return;
			}
		}

		// Not yet armed. Normal arming path requires uncommitted changes (the
		// commit prompt asks the agent to stage + commit + cherry-pick).
		// But there's a separate scenario where the worktree is "clean" yet
		// the agent already made local commits without cherry-picking onto
		// baseRef — typical when the executor follows the plan's "commit
		// your work" instruction before the auto-review service fires its
		// own prompt. Without this branch, those commits get stranded in
		// the task worktree and the card sits stuck in review.
		if (changed === null || changed <= 0) {
			// Detect "agent committed locally, no cherry-pick yet" by counting
			// commits reachable from worktree HEAD but not from baseRef.
			const aheadCount = await countCommitsAheadOfBaseRef(entry.workspacePath, entry.baseRef);
			if (aheadCount === null || aheadCount <= 0) {
				clearTimer(entry);
				return;
			}
			logInfo(
				`${logTag(entry.taskId, entry.baseRef)} worktree has ${aheadCount} commit(s) ahead of ${entry.baseRef} but no uncommitted changes — arming so the commit prompt can drive the cherry-pick`,
			);
			// Fall through to the arming flow below.
		}
		// Don't arm unless the underlying agent session is actually idle and
		// ready to receive input. Right after kanban restarts, auto-resume
		// spawns `claude --continue` and the card is sitting in `review`
		// (persisted) but the agent's TUI is still loading/resuming — pasting
		// the commit prompt at that moment loses bytes. Wait until the agent
		// emits a fresh `Stop` (which moves the session to `awaiting_review`
		// and re-fires `registerTaskForAutoReview` via the to_review hook).
		const terminalManager = deps.getTerminalManagerForWorkspace(entry.workspaceId);
		const sessionSummary = terminalManager?.getSummary(entry.taskId) ?? null;
		if (!sessionSummary || sessionSummary.state !== "awaiting_review") {
			clearTimer(entry);
			return;
		}
		const inFlight = inFlightByBaseRef.get(entry.baseRef);
		if (inFlight && inFlight !== entry.taskId) {
			enqueue(entry.baseRef, entry.taskId);
			return;
		}
		inFlightByBaseRef.set(entry.baseRef, entry.taskId);
		scheduleAction(entry, entry.autoReviewMode, () => {
			void executeCommitOrPr(entry).catch((err) => {
				logError(`${logTag(entry.taskId, entry.baseRef)} executeCommitOrPr threw:`, err);
				releaseSlot(entry.baseRef, entry.taskId);
			});
		});
	}

	function registerTaskForAutoReview(params: RegisterTaskForAutoReviewParams): void {
		const existing = pendingByTaskId.get(params.taskId);
		if (existing) {
			// Refresh fields in case the task was re-registered (e.g. browser
			// reconnect). Don't reset armed-state — the verification logic
			// continues to apply.
			existing.workspaceId = params.workspaceId;
			existing.workspacePath = params.workspacePath;
			existing.baseRef = params.baseRef;
			existing.autoReviewMode = params.autoReviewMode;
			void evaluate(existing);
			return;
		}
		const rehydrate = params.persistedArmState ?? null;
		// On rehydrate we reset the grace-window clock to `now` so that any
		// kanban downtime between the original arm and this register doesn't
		// eat into the cherry-pick wait. The original arm timestamp is not
		// load-bearing — the baselines (baseRefTipAtArm + headCommitAtArm)
		// are what `evaluate` compares against.
		const entry: PendingEntry = {
			workspaceId: params.workspaceId,
			workspacePath: params.workspacePath,
			taskId: params.taskId,
			baseRef: params.baseRef,
			autoReviewMode: params.autoReviewMode,
			armed: rehydrate !== null,
			armedAt: rehydrate !== null ? Date.now() : null,
			baseRefTipAtArm: rehydrate?.baseRefTipAtArm ?? null,
			headCommitAtArm: rehydrate?.headCommitAtArm ?? null,
			scheduledAction: null,
			actionTimer: null,
			moveToTrashInFlight: false,
			armedFromRehydrate: rehydrate !== null,
			registeredAt: Date.now(),
			currentColumnId: "review",
			verificationRecheckTimer: null,
		};
		pendingByTaskId.set(params.taskId, entry);
		acquireMetadataSubscription(params.workspaceId, params.workspacePath);
		// Rehydrated entries also need the baseRef serialization slot held so
		// concurrent commit attempts on the same baseRef don't double-fire
		// while we wait for the verification path to complete.
		if (rehydrate !== null) {
			const inFlight = inFlightByBaseRef.get(entry.baseRef);
			if (!inFlight) {
				inFlightByBaseRef.set(entry.baseRef, entry.taskId);
			}
		}
		logInfo(
			`${logTag(entry.taskId, entry.baseRef)} registered for auto-review (mode=${entry.autoReviewMode}${rehydrate !== null ? ", rehydrated as armed" : ""})`,
		);
		// Seed `latestMetadataByTaskId` from the monitor's current cache so
		// `evaluate` can fire immediately. The monitor only emits
		// `onMetadataUpdated` on snapshot diffs, so without this seed a newly
		// registered task with stable git state would never get evaluated.
		const currentSnapshot = deps.getCurrentWorkspaceMetadata(params.workspaceId);
		if (currentSnapshot) {
			for (const tw of currentSnapshot.taskWorkspaces) {
				latestMetadataByTaskId.set(tw.taskId, tw);
			}
		}
		void evaluate(entry);
	}

	function onWorkspaceMetadataUpdated(workspaceId: string, metadata: RuntimeWorkspaceMetadata): void {
		for (const tw of metadata.taskWorkspaces) {
			latestMetadataByTaskId.set(tw.taskId, tw);
			const entry = pendingByTaskId.get(tw.taskId);
			if (!entry || entry.workspaceId !== workspaceId) {
				continue;
			}
			void evaluate(entry).catch((err) => {
				logError(`${logTag(entry.taskId, entry.baseRef)} evaluate failed:`, err);
			});
		}
	}

	function onWorkspaceStateUpdated(workspaceId: string, workspacePath: string, board: RuntimeBoardData): void {
		// Source of truth = current column position. A card in `review` with
		// `autoReviewEnabled` gets a pending entry; cards in `in_progress` are
		// only tracked transiently when the card was *armed* in review and the
		// agent has just reactivated to perform the auto-commit (the
		// `to_in_progress` hook moves the card mid-commit). We don't want to
		// drop the entry in that window — verification + trash still has to
		// run when changedFiles drops to 0 and baseRef has advanced.
		const reviewCardsById = new Map<string, RuntimeBoardData["columns"][number]["cards"][number]>();
		const inProgressCardsById = new Map<string, RuntimeBoardData["columns"][number]["cards"][number]>();
		for (const column of board.columns) {
			if (column.id === "review") {
				for (const card of column.cards) {
					reviewCardsById.set(card.id, card);
				}
			} else if (column.id === "in_progress") {
				for (const card of column.cards) {
					inProgressCardsById.set(card.id, card);
				}
			}
		}

		// Register cards now in review with autoReviewEnabled.
		for (const [taskId, card] of reviewCardsById) {
			if (pendingByTaskId.has(taskId)) {
				const entry = pendingByTaskId.get(taskId);
				if (entry) {
					entry.currentColumnId = "review";
				}
				continue;
			}
			if (card.autoReviewEnabled !== true) {
				continue;
			}
			registerTaskForAutoReview({
				workspaceId,
				workspacePath,
				taskId,
				baseRef: card.baseRef,
				autoReviewMode: card.autoReviewMode ?? "commit",
				persistedArmState: card.autoReviewArmState ?? null,
			});
		}

		// For every tracked entry whose card is no longer in review:
		//   - if armed → keep tracking regardless of where the card went.
		//     The `inFlightByBaseRef` slot stays held so no other task on the
		//     same baseRef can fire a commit prompt while the agent may still
		//     be mid-cherry-pick. The verification path (or the grace-window
		//     timeout) is the ONLY way to release that slot. Releasing here
		//     would let a queued sibling fire its prompt and we'd end up with
		//     two agents fighting over the same target worktree on
		//     cherry-pick — which is exactly what `baseRef` serialization
		//     exists to prevent.
		//   - otherwise (unarmed, card left the active columns) → drop.
		// Build a lookup of cards currently in the trash column for the
		// armed-entry guard below: trash is terminal, and an armed entry
		// pointing at a trashed card should release its baseRef slot
		// immediately so the queued siblings can fire their commit prompts.
		// Without this, a card that was armed → trashed (by auto-review's own
		// move-to-trash, or by `kanban task trash`, or by the user) keeps the
		// `inFlightByBaseRef` slot pinned forever, queueing every subsequent
		// task on the same baseRef behind a zombie. This is especially
		// visible after a kanban restart: the persisted `autoReviewArmState`
		// on a trashed card rehydrates the entry as armed even though the
		// worktree is long gone.
		const trashCardIds = new Set<string>();
		for (const column of board.columns) {
			if (column.id === "trash") {
				for (const card of column.cards) {
					trashCardIds.add(card.id);
				}
			}
		}
		for (const [taskId, entry] of pendingByTaskId) {
			if (entry.workspaceId !== workspaceId) {
				continue;
			}
			if (reviewCardsById.has(taskId)) {
				continue;
			}
			if (entry.armed) {
				if (inProgressCardsById.has(taskId)) {
					entry.currentColumnId = "in_progress";
					// Card may have been dragged out by the user or moved by
					// hook-driven column-sync while the cherry-pick is in
					// flight. Keep the entry — verification or the grace
					// timeout will retire it cleanly and release the baseRef
					// slot at that point.
					continue;
				}
				if (trashCardIds.has(taskId)) {
					// Trashed-while-armed: drop the entry and release the
					// slot. There is no path back from trash, so the queued
					// siblings on this baseRef would block forever otherwise.
					clearTimer(entry);
					clearVerificationRecheck(entry);
					pendingByTaskId.delete(taskId);
					latestMetadataByTaskId.delete(taskId);
					releaseSlot(entry.baseRef, taskId);
					releaseMetadataSubscription(entry.workspaceId);
					logInfo(`${logTag(taskId, entry.baseRef)} armed but card moved to trash — releasing slot`);
					continue;
				}
				// Card moved out of review/in_progress to some other column
				// (rare but possible if a user manually edits the board).
				// Keep tracking — verification or grace timeout still owns
				// the slot release.
				continue;
			}
			const sinceRegistered = Date.now() - entry.registeredAt;
			if (sinceRegistered < UNARMED_DROP_GRACE_MS) {
				if (inProgressCardsById.has(taskId)) {
					entry.currentColumnId = "in_progress";
				}
				// Inside the grace window. Keep the entry so the next
				// metadata tick or board update can give `evaluate` a
				// chance to arm — the agent may already have committed
				// and cherry-picked, in which case verification will
				// fire on the very next poll. Drop only after the
				// window elapses if the entry is still unarmed.
				continue;
			}
			clearTimer(entry);
			clearVerificationRecheck(entry);
			pendingByTaskId.delete(taskId);
			latestMetadataByTaskId.delete(taskId);
			releaseSlot(entry.baseRef, taskId);
			releaseMetadataSubscription(entry.workspaceId);
			logInfo(`${logTag(taskId, entry.baseRef)} no longer in review, unregistering`);
		}
	}

	function close(): void {
		for (const entry of pendingByTaskId.values()) {
			clearTimer(entry);
			clearVerificationRecheck(entry);
		}
		pendingByTaskId.clear();
		latestMetadataByTaskId.clear();
		inFlightByBaseRef.clear();
		queueByBaseRef.clear();
		// Release every still-active metadata subscription so the monitor
		// can stop polling on shutdown.
		for (const workspaceId of subscriptionCountByWorkspaceId.keys()) {
			deps.unsubscribeWorkspaceMetadataMonitor(workspaceId);
		}
		subscriptionCountByWorkspaceId.clear();
		subscribedWorkspacePaths.clear();
	}

	/**
	 * Move a task's card between columns on the persisted board, with a
	 * pre-move `auto_action_pending` broadcast so connected frontends can
	 * play the move animation in sync with the upcoming
	 * `workspace_state_updated`. The mutation happens regardless of browser
	 * presence, so the transition works browser-independently.
	 *
	 * Used as the server-side counterpart of the upstream frontend logic in
	 * `web-ui/src/hooks/use-board-interactions.ts` that watches the session
	 * state machine and shuffles cards. See
	 * `.plan/docs/fork-server-side-auto-review.md`.
	 */
	async function moveCard(
		workspaceId: string,
		workspacePath: string,
		taskId: string,
		fromColumnId: AutoActionPendingPayload["fromColumnId"],
		action: AutoActionPendingPayload["action"],
		targetColumnId: "review" | "in_progress" | "trash",
	): Promise<void> {
		try {
			deps.broadcastAutoActionPending({ workspaceId, taskId, fromColumnId, action });
			// Yield briefly so any connected frontend can start its animation
			// before the actual saveState lands.
			await new Promise<void>((resolve) => setTimeout(resolve, MOVE_ANIMATION_GRACE_MS));

			const result = await mutateWorkspaceState<{ moved: boolean }>(workspacePath, (latestState) => {
				// Trash is terminal: never resurrect a card from trash via the
				// runtime-state-hub column-sync (which calls
				// `moveTaskInProgressToReview` on every PTY exit, including
				// the legitimate stopTaskSession kanban itself issues right
				// after auto-review moves the card to trash). Without this
				// guard, the trashed card gets pulled back to review by the
				// post-trash PTY-exit listener and the next auto-review tick
				// re-registers it — visible bug from 9992f REFACTOR01:
				// auto-review logged `moved to trash` and was immediately
				// followed by `registered for auto-review` for the same task.
				if (targetColumnId !== "trash") {
					for (const column of latestState.board.columns) {
						if (column.id === "trash" && column.cards.some((card) => card.id === taskId)) {
							return { board: latestState.board, value: { moved: false }, save: false };
						}
					}
				}
				const moved = moveTaskToColumn(latestState.board, taskId, targetColumnId, Date.now());
				if (!moved.moved) {
					return { board: latestState.board, value: { moved: false }, save: false };
				}
				const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: moved.board };
				return { board: nextState.board, value: { moved: true } };
			});

			if (result.saved) {
				logInfo(`${logTag(taskId, "?")} moved ${fromColumnId} → ${targetColumnId}`);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
			}
		} catch (err) {
			logError(`${logTag(taskId, "?")} move ${fromColumnId} → ${targetColumnId} failed`, err);
		}
	}

	function moveTaskInProgressToReview(workspaceId: string, workspacePath: string, taskId: string): Promise<void> {
		return moveCard(workspaceId, workspacePath, taskId, "in_progress", "move_to_review", "review");
	}

	function moveTaskReviewToInProgress(workspaceId: string, workspacePath: string, taskId: string): Promise<void> {
		return moveCard(workspaceId, workspacePath, taskId, "review", "move_to_in_progress", "in_progress");
	}

	/**
	 * Move a task whose session was just marked `interrupted` to the trash
	 * column. Mirrors the upstream frontend behaviour. The current column is
	 * looked up via the persisted board so the broadcast carries the right
	 * `fromColumnId` for the animation. Linked-task relinking is handled by
	 * `trashTaskAndGetReadyLinkedTaskIds`.
	 */
	async function moveInterruptedTaskToTrash(
		workspaceId: string,
		workspacePath: string,
		taskId: string,
	): Promise<void> {
		try {
			const board = await loadWorkspaceBoardById(workspaceId);
			let fromColumnId: string | null = null;
			for (const column of board.columns) {
				if (column.cards.some((card) => card.id === taskId)) {
					fromColumnId = column.id;
					break;
				}
			}
			if (fromColumnId === null || fromColumnId === "trash") {
				return;
			}
			if (fromColumnId === "in_progress" || fromColumnId === "review") {
				deps.broadcastAutoActionPending({
					workspaceId,
					taskId,
					fromColumnId,
					action: "move_to_trash",
				});
				await new Promise<void>((resolve) => setTimeout(resolve, MOVE_ANIMATION_GRACE_MS));
			}
			const result = await mutateWorkspaceState<{ moved: boolean }>(workspacePath, (latestState) => {
				const trashed = trashTaskAndGetReadyLinkedTaskIds(latestState.board, taskId);
				if (!trashed.moved) {
					return { board: latestState.board, value: { moved: false }, save: false };
				}
				const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: trashed.board };
				return { board: nextState.board, value: { moved: true } };
			});
			if (result.saved) {
				logInfo(`${logTag(taskId, "?")} interrupted → trash (from ${fromColumnId})`);
				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
			}
		} catch (err) {
			logError(`${logTag(taskId, "?")} move interrupted → trash failed`, err);
		}
	}

	return {
		registerTaskForAutoReview,
		moveTaskInProgressToReview,
		moveTaskReviewToInProgress,
		moveInterruptedTaskToTrash,
		onWorkspaceMetadataUpdated,
		onWorkspaceStateUpdated,
		close,
	};
}
