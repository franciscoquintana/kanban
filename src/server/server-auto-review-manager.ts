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
import { mutateWorkspaceState } from "../state/workspace-state.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { getBranchTip } from "../workspace/git-sync.js";
import { logError, logInfo, logWarn } from "./server-log.js";

const ACTION_DEBOUNCE_MS = 500;

type ScheduledAction = "commit" | "pr" | "move_to_trash";
// Microsleep we yield before doing the actual move-to-trash mutation, to give
// connected frontends time to start the local move animation (after we've
// emitted the `auto_action_pending` broadcast). Empirical: 80ms is enough on
// localhost and remote SSH+tunnel without being noticeable.
const MOVE_ANIMATION_GRACE_MS = 80;

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
}

export interface RegisterTaskForAutoReviewParams {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	baseRef: string;
	autoReviewMode: RuntimeTaskAutoReviewMode;
}

export interface ServerAutoReviewManager {
	registerTaskForAutoReview(params: RegisterTaskForAutoReviewParams): void;
	moveTaskInProgressToReview(workspaceId: string, workspacePath: string, taskId: string): Promise<void>;
	moveTaskReviewToInProgress(workspaceId: string, workspacePath: string, taskId: string): Promise<void>;
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

	function clearTimer(entry: PendingEntry): void {
		if (entry.actionTimer !== null) {
			clearTimeout(entry.actionTimer);
			entry.actionTimer = null;
			entry.scheduledAction = null;
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

	async function executeCommitOrPr(entry: PendingEntry): Promise<void> {
		const meta = latestMetadataByTaskId.get(entry.taskId);
		if (!meta) {
			logWarn(`${logTag(entry.taskId, entry.baseRef)} no metadata available, skipping commit`);
			return;
		}

		// Capture baselines BEFORE sending the prompt so the verification later
		// is faithful (the agent might commit very quickly).
		const baseRefTip = await getBranchTip(entry.workspacePath, entry.baseRef);
		entry.baseRefTipAtArm = baseRefTip;
		entry.headCommitAtArm = meta.headCommit;
		entry.armed = true;
		entry.armedAt = Date.now();

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
				const pasted = terminalManager.writeInput(entry.taskId, Buffer.from(prompt, "utf8"));
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
				fromColumnId: "review",
				action: "move_to_trash",
			});
			// Yield briefly so any connected frontend can start its local
			// move animation before our state mutation broadcast lands.
			await new Promise<void>((resolve) => setTimeout(resolve, MOVE_ANIMATION_GRACE_MS));

			const mutation = await mutateWorkspaceState<{ moved: boolean }>(entry.workspacePath, (latestState) => {
				const trashed = trashTaskAndGetReadyLinkedTaskIds(latestState.board, entry.taskId);
				if (!trashed.moved) {
					return { board: latestState.board, value: { moved: false }, save: false };
				}
				const nextState: RuntimeWorkspaceStateResponse = { ...latestState, board: trashed.board };
				return { board: nextState.board, value: { moved: true } };
			});

			if (mutation.saved) {
				logInfo(`${logTag(entry.taskId, entry.baseRef)} moved to trash`);
				const terminalManager = deps.getTerminalManagerForWorkspace(entry.workspaceId);
				terminalManager?.stopTaskSession(entry.taskId);
				void deps.broadcastRuntimeWorkspaceStateUpdated(entry.workspaceId, entry.workspacePath);
			} else {
				logInfo(`${logTag(entry.taskId, entry.baseRef)} already gone from review, nothing to trash`);
			}
		} catch (err) {
			logError(`${logTag(entry.taskId, entry.baseRef)} move-to-trash failed:`, err);
		} finally {
			pendingByTaskId.delete(entry.taskId);
			latestMetadataByTaskId.delete(entry.taskId);
			releaseSlot(entry.baseRef, entry.taskId);
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
		releaseSlot(entry.baseRef, entry.taskId);
	}

	async function evaluate(entry: PendingEntry): Promise<void> {
		const meta = latestMetadataByTaskId.get(entry.taskId);
		const changed = meta?.changedFiles ?? null;

		// `RuntimeTaskAutoReviewMode` is `"commit" | "pr"` in v0.1.67. The
		// historical `"move_to_trash"` mode was removed upstream in commit
		// b5e4b2e ("remove move_to_trash auto-review"). If they ever bring
		// back a "skip-commit" trash mode, branch on it here.
		if (entry.armed) {
			if (changed === null || changed > 0) {
				// Still working. Don't decide yet.
				clearTimer(entry);
				return;
			}
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
				disarmWithoutTrash(
					entry,
					`baseRef tip did not advance (${entry.baseRefTipAtArm}). Commit was NOT propagated to ${entry.baseRef}.`,
				);
				return;
			}
			logInfo(
				`${logTag(entry.taskId, entry.baseRef)} baseRef advanced ${entry.baseRefTipAtArm} → ${tipNow}, scheduling trash`,
			);
			scheduleAction(entry, "move_to_trash", () => {
				void executeMoveToTrash(entry);
			});
			return;
		}

		// Not yet armed. Need changes to commit.
		if (changed === null || changed <= 0) {
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
		const entry: PendingEntry = {
			workspaceId: params.workspaceId,
			workspacePath: params.workspacePath,
			taskId: params.taskId,
			baseRef: params.baseRef,
			autoReviewMode: params.autoReviewMode,
			armed: false,
			armedAt: null,
			baseRefTipAtArm: null,
			headCommitAtArm: null,
			scheduledAction: null,
			actionTimer: null,
			moveToTrashInFlight: false,
		};
		pendingByTaskId.set(params.taskId, entry);
		logInfo(`${logTag(entry.taskId, entry.baseRef)} registered for auto-review (mode=${entry.autoReviewMode})`);
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
		// Source of truth = current column position. The to_review hook from
		// the agent only flips the session state machine; it does NOT move
		// the card. The card transitions into review when:
		//   - a user drags it, or
		//   - a programmatic move is triggered (frontend / future server).
		// Because of that, registering on the hook can race the card-move
		// (we'd register, then a state-update fires the OLD board with the
		// card still in in_progress, and we'd unregister immediately).
		//
		// So we treat the column as authoritative: a card present in `review`
		// with autoReviewEnabled gets a pending entry; a card no longer in
		// `review` gets dropped. Simple, idempotent, race-free.
		const reviewCardsById = new Map<string, RuntimeBoardData["columns"][number]["cards"][number]>();
		for (const column of board.columns) {
			if (column.id !== "review") {
				continue;
			}
			for (const card of column.cards) {
				reviewCardsById.set(card.id, card);
			}
		}

		// Register cards now in review with autoReviewEnabled.
		for (const [taskId, card] of reviewCardsById) {
			if (pendingByTaskId.has(taskId)) {
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
			});
		}

		// Drop tracked tasks that have left the review column.
		for (const [taskId, entry] of pendingByTaskId) {
			if (entry.workspaceId !== workspaceId) {
				continue;
			}
			if (reviewCardsById.has(taskId)) {
				continue;
			}
			clearTimer(entry);
			pendingByTaskId.delete(taskId);
			latestMetadataByTaskId.delete(taskId);
			releaseSlot(entry.baseRef, taskId);
			logInfo(`${logTag(taskId, entry.baseRef)} no longer in review, unregistering`);
		}
	}

	function close(): void {
		for (const entry of pendingByTaskId.values()) {
			clearTimer(entry);
		}
		pendingByTaskId.clear();
		latestMetadataByTaskId.clear();
		inFlightByBaseRef.clear();
		queueByBaseRef.clear();
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

	return {
		registerTaskForAutoReview,
		moveTaskInProgressToReview,
		moveTaskReviewToInProgress,
		onWorkspaceMetadataUpdated,
		onWorkspaceStateUpdated,
		close,
	};
}
