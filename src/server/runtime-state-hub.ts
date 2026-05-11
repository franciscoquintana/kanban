// Streams live runtime state to browser clients over websocket.
// It listens to terminal and native Cline updates, normalizes them into the
// shared API contract, and fans out workspace-scoped snapshots and deltas.
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClineTaskMessage, ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type {
	RuntimeClineMcpServerAuthStatus,
	RuntimeStateStreamAutoActionPendingMessage,
	RuntimeStateStreamClineSessionContextUpdatedMessage,
	RuntimeStateStreamErrorMessage,
	RuntimeStateStreamMcpAuthUpdatedMessage,
	RuntimeStateStreamMessage,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
	RuntimeStateStreamTaskChatClearedMessage,
	RuntimeStateStreamTaskChatMessage,
	RuntimeStateStreamTaskReadyForReviewMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeStateStreamWorkspaceMetadataMessage,
	RuntimeStateStreamWorkspaceStateMessage,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { AutoActionPendingPayload, ServerAutoReviewManager } from "./server-auto-review-manager";
import { logError } from "./server-log";
import { createWorkspaceMetadataMonitor } from "./workspace-metadata-monitor";
import type { ResolvedWorkspaceStreamTarget, WorkspaceRegistry } from "./workspace-registry";

const TASK_SESSION_STREAM_BATCH_MS = 150;

export interface DisposeRuntimeStateWorkspaceOptions {
	disconnectClients?: boolean;
	closeClientErrorMessage?: string;
}

export interface CreateRuntimeStateHubDependencies {
	workspaceRegistry: Pick<
		WorkspaceRegistry,
		"resolveWorkspaceForStream" | "buildProjectsPayload" | "buildWorkspaceStateSnapshot" | "getWorkspacePathById"
	>;
	// Lazy reference: the auto-review manager is constructed inside
	// `createRuntimeServer` (it needs access to the cline session services
	// map that lives there) and assigned to `autoReviewManagerRef.current`
	// before any metadata polling begins. The hub reads via the ref so we
	// avoid circular constructor wiring.
	autoReviewManagerRef?: { current: ServerAutoReviewManager | null };
}

export interface RuntimeStateHub {
	trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => void;
	trackClineTaskSessionService: (workspaceId: string, workspacePath: string, service: ClineTaskSessionService) => void;
	broadcastTaskChatMessage: (workspaceId: string, taskId: string, message: ClineTaskMessage) => void;
	broadcastTaskChatCleared: (workspaceId: string, taskId: string) => void;
	handleUpgrade: (
		request: IncomingMessage,
		socket: Parameters<WebSocketServer["handleUpgrade"]>[1],
		head: Buffer,
		context: {
			requestedWorkspaceId: string | null;
		},
	) => void;
	disposeWorkspace: (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => void;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void>;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void>;
	broadcastClineMcpAuthStatusesUpdated: (statuses: RuntimeClineMcpServerAuthStatus[]) => void;
	bumpClineSessionContextVersion: () => void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	broadcastAutoActionPending: (payload: AutoActionPendingPayload) => void;
	// Manager-driven subscription to the metadata monitor so polling
	// continues even when no browser is connected. Each call increments the
	// monitor's subscriber count for the workspace.
	subscribeWorkspaceMetadataMonitor: (workspaceId: string, workspacePath: string) => Promise<void>;
	unsubscribeWorkspaceMetadataMonitor: (workspaceId: string) => void;
	getCurrentWorkspaceMetadata: (workspaceId: string) => RuntimeWorkspaceMetadata | null;
	close: () => Promise<void>;
}

export function createRuntimeStateHub(deps: CreateRuntimeStateHubDependencies): RuntimeStateHub {
	const terminalSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const clineSummaryUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const clineMessageUnsubscribeByWorkspaceId = new Map<string, () => void>();
	const clinePreviousSummaryByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const pendingTaskSessionSummariesByWorkspaceId = new Map<string, Map<string, RuntimeTaskSessionSummary>>();
	const taskSessionBroadcastTimersByWorkspaceId = new Map<string, NodeJS.Timeout>();
	const runtimeStateClientsByWorkspaceId = new Map<string, Set<WebSocket>>();
	const runtimeStateClients = new Set<WebSocket>();
	const runtimeStateWorkspaceIdByClient = new Map<WebSocket, string>();
	let clineSessionContextVersion = 0;
	const runtimeStateWebSocketServer = new WebSocketServer({ noServer: true });
	const workspaceMetadataMonitor = createWorkspaceMetadataMonitor({
		onMetadataUpdated: (workspaceId, workspaceMetadata) => {
			// Always notify the server-side auto-review manager so it keeps a
			// fresh view of changedFiles / headCommit even when no browser is
			// connected. Has to come BEFORE the early-return below.
			deps.autoReviewManagerRef?.current?.onWorkspaceMetadataUpdated(workspaceId, workspaceMetadata);

			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (!clients || clients.size === 0) {
				return;
			}
			const payload: RuntimeStateStreamWorkspaceMetadataMessage = {
				type: "workspace_metadata_updated",
				workspaceId,
				workspaceMetadata,
			};
			for (const client of clients) {
				sendRuntimeStateMessage(client, payload);
			}
		},
	});

	const sendRuntimeStateMessage = (client: WebSocket, payload: RuntimeStateStreamMessage) => {
		if (client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			client.send(JSON.stringify(payload));
		} catch {
			// Ignore websocket write errors; close handlers clean up disconnected sockets.
		}
	};

	const broadcastRuntimeProjectsUpdated = async (preferredCurrentProjectId: string | null): Promise<void> => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		try {
			const payload = await deps.workspaceRegistry.buildProjectsPayload(preferredCurrentProjectId);
			for (const client of runtimeStateClients) {
				sendRuntimeStateMessage(client, {
					type: "projects_updated",
					currentProjectId: payload.currentProjectId,
					projects: payload.projects,
				} satisfies RuntimeStateStreamProjectsMessage);
			}
		} catch {
			// Ignore transient project summary failures; next update will resync.
		}
	};

	const broadcastClineMcpAuthStatusesUpdated = (statuses: RuntimeClineMcpServerAuthStatus[]) => {
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamMcpAuthUpdatedMessage = {
			type: "mcp_auth_updated",
			statuses,
		};
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const bumpClineSessionContextVersion = () => {
		clineSessionContextVersion += 1;
		if (runtimeStateClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamClineSessionContextUpdatedMessage = {
			type: "cline_session_context_updated",
			version: clineSessionContextVersion,
		};
		for (const client of runtimeStateClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const flushTaskSessionSummaries = (workspaceId: string) => {
		const pending = pendingTaskSessionSummariesByWorkspaceId.get(workspaceId);
		if (!pending || pending.size === 0) {
			return;
		}
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
		const summaries = Array.from(pending.values());
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (runtimeClients && runtimeClients.size > 0) {
			const payload: RuntimeStateStreamTaskSessionsMessage = {
				type: "task_sessions_updated",
				workspaceId,
				summaries,
			};
			for (const client of runtimeClients) {
				sendRuntimeStateMessage(client, payload);
			}
		}
		void broadcastRuntimeProjectsUpdated(workspaceId);
	};

	const queueTaskSessionSummaryBroadcast = (workspaceId: string, summary: RuntimeTaskSessionSummary) => {
		const pending =
			pendingTaskSessionSummariesByWorkspaceId.get(workspaceId) ?? new Map<string, RuntimeTaskSessionSummary>();
		pending.set(summary.taskId, summary);
		pendingTaskSessionSummariesByWorkspaceId.set(workspaceId, pending);
		if (taskSessionBroadcastTimersByWorkspaceId.has(workspaceId)) {
			return;
		}
		const timer = setTimeout(() => {
			taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
			flushTaskSessionSummaries(workspaceId);
		}, TASK_SESSION_STREAM_BATCH_MS);
		timer.unref();
		taskSessionBroadcastTimersByWorkspaceId.set(workspaceId, timer);
	};

	const broadcastTaskChatMessage = (workspaceId: string, taskId: string, message: ClineTaskMessage) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskChatMessage = {
			type: "task_chat_message",
			workspaceId,
			taskId,
			message,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const broadcastTaskChatCleared = (workspaceId: string, taskId: string) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskChatClearedMessage = {
			type: "task_chat_cleared",
			workspaceId,
			taskId,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const disposeTaskSessionSummaryBroadcast = (workspaceId: string) => {
		const timer = taskSessionBroadcastTimersByWorkspaceId.get(workspaceId);
		if (timer) {
			clearTimeout(timer);
		}
		taskSessionBroadcastTimersByWorkspaceId.delete(workspaceId);
		pendingTaskSessionSummariesByWorkspaceId.delete(workspaceId);
	};

	const cleanupRuntimeStateClient = (client: WebSocket) => {
		const workspaceId = runtimeStateWorkspaceIdByClient.get(client);
		if (workspaceId) {
			workspaceMetadataMonitor.disconnectWorkspace(workspaceId);
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (clients) {
				clients.delete(client);
				if (clients.size === 0) {
					runtimeStateClientsByWorkspaceId.delete(workspaceId);
				}
			}
		}
		runtimeStateWorkspaceIdByClient.delete(client);
		runtimeStateClients.delete(client);
	};

	const disposeWorkspace = (workspaceId: string, options?: DisposeRuntimeStateWorkspaceOptions) => {
		const unsubscribeSummary = terminalSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeSummary) {
			try {
				unsubscribeSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		terminalSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		const unsubscribeClineSummary = clineSummaryUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeClineSummary) {
			try {
				unsubscribeClineSummary();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		clineSummaryUnsubscribeByWorkspaceId.delete(workspaceId);
		clinePreviousSummaryByWorkspaceId.delete(workspaceId);
		const unsubscribeClineMessage = clineMessageUnsubscribeByWorkspaceId.get(workspaceId);
		if (unsubscribeClineMessage) {
			try {
				unsubscribeClineMessage();
			} catch {
				// Ignore listener cleanup errors during project removal.
			}
		}
		clineMessageUnsubscribeByWorkspaceId.delete(workspaceId);
		disposeTaskSessionSummaryBroadcast(workspaceId);
		workspaceMetadataMonitor.disposeWorkspace(workspaceId);

		if (!options?.disconnectClients) {
			return;
		}

		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			runtimeStateClientsByWorkspaceId.delete(workspaceId);
			return;
		}

		for (const runtimeClient of runtimeClients) {
			if (options.closeClientErrorMessage) {
				sendRuntimeStateMessage(runtimeClient, {
					type: "error",
					message: options.closeClientErrorMessage,
				} satisfies RuntimeStateStreamErrorMessage);
			}
			try {
				runtimeClient.close();
			} catch {
				// Ignore close failures while disposing removed workspace clients.
			}
			cleanupRuntimeStateClient(runtimeClient);
		}
		runtimeStateClientsByWorkspaceId.delete(workspaceId);
	};

	const broadcastRuntimeWorkspaceStateUpdated = async (workspaceId: string, workspacePath: string): Promise<void> => {
		// Build the snapshot regardless of clients, because the metadata
		// monitor and the auto-review manager need to know about board moves
		// (e.g. tasks dragged out of review) even with no UI connected.
		try {
			const workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
			const clients = runtimeStateClientsByWorkspaceId.get(workspaceId);
			if (clients && clients.size > 0) {
				const payload: RuntimeStateStreamWorkspaceStateMessage = {
					type: "workspace_state_updated",
					workspaceId,
					workspaceState,
				};
				for (const client of clients) {
					sendRuntimeStateMessage(client, payload);
				}
			}
			await workspaceMetadataMonitor.updateWorkspaceState({
				workspaceId,
				workspacePath,
				board: workspaceState.board,
			});
			deps.autoReviewManagerRef?.current?.onWorkspaceStateUpdated(workspaceId, workspacePath, workspaceState.board);
		} catch {
			// Ignore transient state read failures; next update will resync.
		}
	};

	const broadcastTaskReadyForReview = (workspaceId: string, taskId: string) => {
		// Register with the server-side auto-review manager regardless of
		// connected clients. The manager looks up the task's autoReview
		// settings from the persisted board.
		const manager = deps.autoReviewManagerRef?.current;
		if (manager) {
			void (async () => {
				try {
					const board = await loadWorkspaceBoardById(workspaceId);
					const card = board.columns.flatMap((col) => col.cards).find((c) => c.id === taskId);
					if (card?.autoReviewEnabled === true) {
						const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
						if (workspacePath) {
							manager.registerTaskForAutoReview({
								workspaceId,
								workspacePath,
								taskId,
								baseRef: card.baseRef,
								autoReviewMode: card.autoReviewMode ?? "commit",
								persistedArmState: card.autoReviewArmState ?? null,
							});
						}
					}
				} catch (err) {
					// Best-effort registration. Auto-review manager is optional.
					logError(`[runtime-state-hub] auto-review registration failed for task ${taskId}:`, err);
				}
			})();
		}

		const runtimeClients = runtimeStateClientsByWorkspaceId.get(workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamTaskReadyForReviewMessage = {
			type: "task_ready_for_review",
			workspaceId,
			taskId,
			triggeredAt: Date.now(),
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	const broadcastAutoActionPending = (input: AutoActionPendingPayload) => {
		const runtimeClients = runtimeStateClientsByWorkspaceId.get(input.workspaceId);
		if (!runtimeClients || runtimeClients.size === 0) {
			return;
		}
		const payload: RuntimeStateStreamAutoActionPendingMessage = {
			type: "auto_action_pending",
			workspaceId: input.workspaceId,
			taskId: input.taskId,
			fromColumnId: input.fromColumnId,
			action: input.action,
		};
		for (const client of runtimeClients) {
			sendRuntimeStateMessage(client, payload);
		}
	};

	runtimeStateWebSocketServer.on("connection", async (client: WebSocket, context: unknown) => {
		client.on("close", () => {
			cleanupRuntimeStateClient(client);
		});
		try {
			const requestedWorkspaceId =
				typeof context === "object" &&
				context !== null &&
				"requestedWorkspaceId" in context &&
				typeof (context as { requestedWorkspaceId?: unknown }).requestedWorkspaceId === "string"
					? (context as { requestedWorkspaceId: string }).requestedWorkspaceId || null
					: null;
			const workspace: ResolvedWorkspaceStreamTarget = await deps.workspaceRegistry.resolveWorkspaceForStream(
				requestedWorkspaceId,
				{
					onRemovedWorkspace: ({ workspaceId, message }) => {
						disposeWorkspace(workspaceId, {
							disconnectClients: true,
							closeClientErrorMessage: message,
						});
					},
				},
			);
			if (client.readyState !== WebSocket.OPEN) {
				cleanupRuntimeStateClient(client);
				return;
			}

			/*
				Connection setup for workspace-scoped runtime streams is intentionally split into two phases.

				We need the initial snapshot to already contain the first workspace metadata payload, but we do not want
				the client to receive a separate "workspace_metadata_updated" event before that snapshot arrives.

				That race can happen if we register the websocket in runtimeStateClientsByWorkspaceId first and then call
				workspaceMetadataMonitor.connectWorkspace(...). connectWorkspace() performs an immediate refresh, and that
				refresh may broadcast "workspace_metadata_updated" to every currently registered workspace client. In that
				old ordering, a newly connected client could observe:

				1. workspace_metadata_updated
				2. snapshot

				which makes the initial load look wrong and forces the UI to process the same logical data twice in the
				opposite order from what readers expect.

				To avoid that, we:

				1. add the socket only to the global runtimeStateClients set so project-wide broadcasts still work
				2. build workspace state and connect the metadata monitor to get the initial metadata snapshot
				3. send the combined "snapshot" message
				4. only then register the socket in runtimeStateClientsByWorkspaceId so future incremental
				   workspace_metadata_updated events can flow normally

				The extra readyState checks and monitor cleanup below are paired with this delayed registration. If the
				socket closes while we are still assembling or sending the initial snapshot, we must disconnect the
				temporary metadata monitor subscription before returning, otherwise we would leave behind subscriber count
				state for a client that never finished the handshake.
			*/
			runtimeStateClients.add(client);
			let monitorWorkspaceId: string | null = null;
			let didConnectWorkspaceMonitor = false;

			try {
				let projectsPayload: {
					currentProjectId: string | null;
					projects: RuntimeStateStreamProjectsMessage["projects"];
				};
				let workspaceState: RuntimeStateStreamSnapshotMessage["workspaceState"];
				let workspaceMetadata: RuntimeStateStreamSnapshotMessage["workspaceMetadata"];
				if (workspace.workspaceId && workspace.workspacePath) {
					monitorWorkspaceId = workspace.workspaceId;
					[projectsPayload, workspaceState] = await Promise.all([
						deps.workspaceRegistry.buildProjectsPayload(workspace.workspaceId),
						deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspace.workspaceId, workspace.workspacePath),
					]);
					workspaceMetadata = await workspaceMetadataMonitor.connectWorkspace({
						workspaceId: workspace.workspaceId,
						workspacePath: workspace.workspacePath,
						board: workspaceState.board,
					});
					didConnectWorkspaceMonitor = true;
				} else {
					projectsPayload = await deps.workspaceRegistry.buildProjectsPayload(null);
					workspaceState = null;
					workspaceMetadata = null;
				}
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				sendRuntimeStateMessage(client, {
					type: "snapshot",
					currentProjectId: projectsPayload.currentProjectId,
					projects: projectsPayload.projects,
					workspaceState,
					workspaceMetadata,
					clineSessionContextVersion,
				} satisfies RuntimeStateStreamSnapshotMessage);
				if (client.readyState !== WebSocket.OPEN) {
					if (monitorWorkspaceId) {
						workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
					}
					cleanupRuntimeStateClient(client);
					return;
				}
				if (monitorWorkspaceId) {
					const workspaceClients =
						runtimeStateClientsByWorkspaceId.get(monitorWorkspaceId) ?? new Set<WebSocket>();
					workspaceClients.add(client);
					runtimeStateClientsByWorkspaceId.set(monitorWorkspaceId, workspaceClients);
					runtimeStateWorkspaceIdByClient.set(client, monitorWorkspaceId);
					const clineSummaries = Array.from(
						clinePreviousSummaryByWorkspaceId.get(monitorWorkspaceId)?.values() ?? [],
					);
					if (clineSummaries.length > 0) {
						sendRuntimeStateMessage(client, {
							type: "task_sessions_updated",
							workspaceId: monitorWorkspaceId,
							summaries: clineSummaries,
						} satisfies RuntimeStateStreamTaskSessionsMessage);
					}
				}
				if (workspace.removedRequestedWorkspacePath) {
					sendRuntimeStateMessage(client, {
						type: "error",
						message: `Project no longer exists on disk and was removed: ${workspace.removedRequestedWorkspacePath}`,
					} satisfies RuntimeStateStreamErrorMessage);
				}
				if (workspace.didPruneProjects) {
					void broadcastRuntimeProjectsUpdated(workspace.workspaceId);
				}
			} catch (error) {
				if (didConnectWorkspaceMonitor && monitorWorkspaceId) {
					workspaceMetadataMonitor.disconnectWorkspace(monitorWorkspaceId);
				}
				const message = error instanceof Error ? error.message : String(error);
				sendRuntimeStateMessage(client, {
					type: "error",
					message,
				} satisfies RuntimeStateStreamErrorMessage);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendRuntimeStateMessage(client, {
				type: "error",
				message,
			} satisfies RuntimeStateStreamErrorMessage);
			client.close();
		}
	});

	return {
		trackTerminalManager: (workspaceId: string, manager: TerminalSessionManager) => {
			if (terminalSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			// Track previous-state per task so we can detect transitions to
			// `interrupted` and tell the auto-review manager to move the
			// card to trash server-side (mirrors the upstream frontend
			// auto-trash on interrupted).
			const previousByTaskId = new Map<string, RuntimeTaskSessionSummary>();
			const unsubscribe = manager.onSummary((summary) => {
				const previous = previousByTaskId.get(summary.taskId);
				previousByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
				if (
					previous &&
					previous.state !== "interrupted" &&
					summary.state === "interrupted" &&
					deps.autoReviewManagerRef?.current
				) {
					const workspacePath = deps.workspaceRegistry.getWorkspacePathById(workspaceId);
					if (workspacePath) {
						void deps.autoReviewManagerRef.current
							.moveInterruptedTaskToTrash(workspaceId, workspacePath, summary.taskId)
							.catch(() => {
								// Best effort; manager logs internally.
							});
					}
				}
			});
			terminalSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
		},
		trackClineTaskSessionService: (workspaceId: string, workspacePath: string, service: ClineTaskSessionService) => {
			if (clineSummaryUnsubscribeByWorkspaceId.has(workspaceId)) {
				return;
			}
			const previousSummariesByTaskId = new Map<string, RuntimeTaskSessionSummary>();
			clinePreviousSummaryByWorkspaceId.set(workspaceId, previousSummariesByTaskId);
			for (const summary of service.listSummaries()) {
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
			}
			const unsubscribe = service.onSummary((summary) => {
				const previousSummary = previousSummariesByTaskId.get(summary.taskId);
				previousSummariesByTaskId.set(summary.taskId, summary);
				queueTaskSessionSummaryBroadcast(workspaceId, summary);
				const didCheckpointChange =
					previousSummary?.latestTurnCheckpoint?.commit !== summary.latestTurnCheckpoint?.commit ||
					previousSummary?.previousTurnCheckpoint?.commit !== summary.previousTurnCheckpoint?.commit;
				if (didCheckpointChange) {
					void broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				}
				if (
					previousSummary &&
					previousSummary.state !== "awaiting_review" &&
					summary.state === "awaiting_review" &&
					(summary.reviewReason === "hook" ||
						summary.reviewReason === "attention" ||
						summary.reviewReason === "error")
				) {
					broadcastTaskReadyForReview(workspaceId, summary.taskId);
				}
				if (
					previousSummary &&
					previousSummary.state !== "interrupted" &&
					summary.state === "interrupted" &&
					deps.autoReviewManagerRef?.current
				) {
					void deps.autoReviewManagerRef.current
						.moveInterruptedTaskToTrash(workspaceId, workspacePath, summary.taskId)
						.catch(() => {
							// Best effort; manager logs internally.
						});
				}
			});
			clineSummaryUnsubscribeByWorkspaceId.set(workspaceId, unsubscribe);
			const unsubscribeMessage = service.onMessage((taskId, message) => {
				broadcastTaskChatMessage(workspaceId, taskId, message);
			});
			clineMessageUnsubscribeByWorkspaceId.set(workspaceId, unsubscribeMessage);
		},
		broadcastTaskChatMessage,
		broadcastTaskChatCleared,
		handleUpgrade: (request, socket, head, context) => {
			runtimeStateWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
				runtimeStateWebSocketServer.emit("connection", ws, context);
			});
		},
		disposeWorkspace,
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated,
		broadcastClineMcpAuthStatusesUpdated,
		bumpClineSessionContextVersion,
		broadcastTaskReadyForReview,
		broadcastAutoActionPending,
		subscribeWorkspaceMetadataMonitor: async (workspaceId, workspacePath) => {
			// Build the snapshot to seed the monitor with the current board.
			// If the read fails, fall back to a connect with an empty board
			// (the monitor will refresh on the first updateWorkspaceState).
			try {
				const workspaceState = await deps.workspaceRegistry.buildWorkspaceStateSnapshot(workspaceId, workspacePath);
				await workspaceMetadataMonitor.connectWorkspace({
					workspaceId,
					workspacePath,
					board: workspaceState.board,
				});
			} catch {
				// Best-effort. The next state-updated broadcast will refresh.
			}
		},
		unsubscribeWorkspaceMetadataMonitor: (workspaceId) => {
			workspaceMetadataMonitor.disconnectWorkspace(workspaceId);
		},
		getCurrentWorkspaceMetadata: (workspaceId) => {
			return workspaceMetadataMonitor.getCurrentMetadata(workspaceId);
		},
		close: async () => {
			for (const timer of taskSessionBroadcastTimersByWorkspaceId.values()) {
				clearTimeout(timer);
			}
			taskSessionBroadcastTimersByWorkspaceId.clear();
			pendingTaskSessionSummariesByWorkspaceId.clear();
			for (const unsubscribe of terminalSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			terminalSummaryUnsubscribeByWorkspaceId.clear();
			for (const unsubscribe of clineSummaryUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			clineSummaryUnsubscribeByWorkspaceId.clear();
			clinePreviousSummaryByWorkspaceId.clear();
			for (const unsubscribe of clineMessageUnsubscribeByWorkspaceId.values()) {
				try {
					unsubscribe();
				} catch {
					// Ignore listener cleanup errors during shutdown.
				}
			}
			clineMessageUnsubscribeByWorkspaceId.clear();
			workspaceMetadataMonitor.close();
			for (const client of runtimeStateClients) {
				try {
					client.terminate();
				} catch {
					// Ignore websocket termination errors during shutdown.
				}
			}
			runtimeStateClients.clear();
			runtimeStateClientsByWorkspaceId.clear();
			runtimeStateWorkspaceIdByClient.clear();
			await new Promise<void>((resolveCloseWebSockets) => {
				runtimeStateWebSocketServer.close(() => {
					resolveCloseWebSockets();
				});
			});
		},
	};
}
