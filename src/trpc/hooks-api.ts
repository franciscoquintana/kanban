import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { BG_ACTIVE_FILE_NAME, resolveTwoPhasePlan } from "../server/two-phase";
import { loadWorkspaceBoardById, loadWorkspaceContextById } from "../state/workspace-state";
import { resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	// Used by the two-phase delegation auto-handoff: when a card with
	// `planAgentId` finishes its plan phase and `.kanban-plan.md` was written,
	// we suppress the normal move-to-review and instead respawn the same card
	// with the exec agent reading the plan as prompt.
	loadScopedRuntimeConfig?: (input: { workspaceId: string; workspacePath: string }) => Promise<RuntimeConfigState>;
	// Server-side counterparts of the upstream frontend auto-move logic
	// (use-board-interactions.ts). With these in place the column moves
	// happen regardless of browser presence. The frontend, when connected,
	// receives `auto_action_pending` first and plays the animation in sync.
	// See `.plan/docs/fork-server-side-auto-review.md`.
	moveTaskInProgressToReview?: (workspaceId: string, workspacePath: string, taskId: string) => Promise<void>;
	moveTaskReviewToInProgress?: (workspaceId: string, workspacePath: string, taskId: string) => Promise<void>;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				// Background-task sentinel: the agent kicked off a long-running
				// subprocess (Bash `&`, nohup, etc.) and dropped this file to
				// tell us its turn-end is not really "done". Skip the to_review
				// move entirely — the agent will emit another Stop after it
				// removes the sentinel.
				if (event === "to_review") {
					try {
						const card = await loadWorkspaceBoardById(workspaceId).then((b) =>
							b?.columns.flatMap((c) => c.cards).find((c) => c.id === taskId),
						);
						if (card) {
							const pathInfo = await getTaskWorkspacePathInfo({
								cwd: workspacePath,
								taskId,
								baseRef: card.baseRef,
							});
							if (pathInfo.exists && existsSync(join(pathInfo.path, BG_ACTIVE_FILE_NAME))) {
								if (body.metadata) {
									manager.applyHookActivity(taskId, body.metadata);
								}
								return { ok: true } satisfies RuntimeHookIngestResponse;
							}
						}
					} catch {
						// Best effort: any failure here falls through to normal handling.
					}
				}

				// Two-phase delegation auto-handoff:
				// If this is the plan phase finishing AND .kanban-plan.md exists,
				// suppress the move-to-review and respawn the card with the exec
				// agent using the plan as prompt.
				//
				// Detection: the hook payload's `metadata.source` carries the
				// agentId that the PTY was spawned with (set via `--source` on
				// the hook command at spawn time, immutable for the PTY's
				// lifetime). This is more reliable than `summary.agentId`,
				// which is racy: the PTY onExit handler in workspace-registry.ts
				// can fire the executor respawn BEFORE this hook handler
				// finishes processing the planner's Stop, in which case
				// `summary.agentId` has already flipped to the executor and
				// the suppression check would falsely skip — letting the card
				// move to review even though the executor is now running. The
				// `source` field is set per-spawn and does not flip.
				const hookSource = body.metadata?.source ?? null;
				if (event === "to_review" && deps.loadScopedRuntimeConfig) {
					try {
						const board = await loadWorkspaceBoardById(workspaceId);
						const card = board?.columns.flatMap((column) => column.cards).find((c) => c.id === taskId);
						const emittingAgentId = hookSource ?? summary.agentId;
						if (card?.planAgentId && emittingAgentId === card.planAgentId) {
							const pathInfo = await getTaskWorkspacePathInfo({
								cwd: workspacePath,
								taskId,
								baseRef: card.baseRef,
							});
							if (pathInfo.exists) {
								const next = resolveTwoPhasePlan(card, pathInfo.path);
								if (next && next.phase === "exec") {
									const runtimeConfig = await deps.loadScopedRuntimeConfig({
										workspaceId,
										workspacePath,
									});
									const resolvedConfig =
										runtimeConfig.selectedAgentId === next.agentId
											? runtimeConfig
											: { ...runtimeConfig, selectedAgentId: next.agentId };
									const resolved = resolveAgentCommand(resolvedConfig);
									if (resolved) {
										// Stop the plan session first so its slot is freed,
										// then spawn the exec phase fresh.
										try {
											manager.stopTaskSession(taskId);
										} catch {
											// best effort
										}
										await manager.startTaskSession({
											taskId,
											agentId: resolved.agentId,
											binary: resolved.binary,
											args: resolved.args,
											autonomousModeEnabled: resolvedConfig.agentAutonomousModeEnabled,
											cwd: pathInfo.path,
											prompt: next.prompt,
											startInPlanMode: next.startInPlanMode,
											workspaceId,
										});
										// Skip the normal to_review move. Card stays in_progress.
										return { ok: true } satisfies RuntimeHookIngestResponse;
									}
								}
							}
						}
					} catch {
						// Best effort: any failure here falls through to normal to_review handling.
					}
				}

				const transitionedSummary =
					event === "to_review" ? manager.transitionToReview(taskId, "hook") : manager.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					try {
						const checkpoint = await checkpointCapture({
							cwd: checkpointCwd,
							taskId,
							turn: nextTurn,
						});
						manager.applyTurnCheckpoint(taskId, checkpoint);
						if (staleRef) {
							void checkpointRefDelete({
								cwd: checkpointCwd,
								ref: staleRef,
							}).catch(() => {
								// Best effort cleanup only.
							});
						}
					} catch {
						// Best effort checkpointing only.
					}
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
					// Move the card from in_progress → review on the persisted board
					// so the transition works regardless of browser presence. The
					// manager broadcasts auto_action_pending first so a connected
					// frontend can play the animation in sync.
					if (deps.moveTaskInProgressToReview) {
						void deps.moveTaskInProgressToReview(workspaceId, workspacePath, taskId).catch(() => {
							// Best effort; manager logs its own errors.
						});
					}
				} else if (event === "to_in_progress") {
					// Inverse: when a previously-paused task is resumed (session
					// state running), move the card review → in_progress. This is
					// the equivalent of `use-board-interactions.ts:459` upstream.
					if (deps.moveTaskReviewToInProgress) {
						void deps.moveTaskReviewToInProgress(workspaceId, workspacePath, taskId).catch(() => {
							// Best effort.
						});
					}
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
