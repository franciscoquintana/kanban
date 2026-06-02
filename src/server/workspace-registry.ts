import { type RuntimeConfigState, toGlobalRuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectSummary,
	RuntimeProjectTaskCounts,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
	type RuntimeWorkspaceIndexEntry,
	removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles,
} from "../state/workspace-state";
import { resolveAgentCommand } from "../terminal/agent-registry";
import { TerminalSessionManager } from "../terminal/session-manager";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { resolveTwoPhasePlan } from "./two-phase";

export interface WorkspaceRegistryScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CreateWorkspaceRegistryDependencies {
	cwd: string;
	loadGlobalRuntimeConfig: () => Promise<RuntimeConfigState>;
	loadRuntimeConfig: (cwd: string) => Promise<RuntimeConfigState>;
	hasGitRepository: (path: string) => boolean;
	pathIsDirectory: (path: string) => Promise<boolean>;
	onTerminalManagerReady?: (workspaceId: string, manager: TerminalSessionManager) => void;
}

export interface DisposeWorkspaceRegistryOptions {
	stopTerminalSessions?: boolean;
}

export interface ResolvedWorkspaceStreamTarget {
	workspaceId: string | null;
	workspacePath: string | null;
	removedRequestedWorkspacePath: string | null;
	didPruneProjects: boolean;
}

export interface RemovedWorkspaceNotice {
	workspaceId: string;
	repoPath: string;
	message: string;
}

export interface WorkspaceRegistry {
	getActiveWorkspaceId: () => string | null;
	getActiveWorkspacePath: () => string | null;
	getWorkspacePathById: (workspaceId: string) => string | null;
	rememberWorkspace: (workspaceId: string, repoPath: string) => void;
	getActiveRuntimeConfig: () => RuntimeConfigState;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	loadScopedRuntimeConfig: (scope: WorkspaceRegistryScope) => Promise<RuntimeConfigState>;
	getTerminalManagerForWorkspace: (workspaceId: string) => TerminalSessionManager | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	setActiveWorkspace: (workspaceId: string, repoPath: string) => Promise<void>;
	clearActiveWorkspace: () => void;
	disposeWorkspace: (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	) => {
		terminalManager: TerminalSessionManager | null;
		workspacePath: string | null;
	};
	summarizeProjectTaskCounts: (workspaceId: string, repoPath: string) => Promise<RuntimeProjectTaskCounts>;
	createProjectSummary: (input: {
		workspaceId: string;
		repoPath: string;
		taskCounts: RuntimeProjectTaskCounts;
	}) => RuntimeProjectSummary;
	buildWorkspaceStateSnapshot: (workspaceId: string, workspacePath: string) => Promise<RuntimeWorkspaceStateResponse>;
	buildProjectsPayload: (preferredCurrentProjectId: string | null) => Promise<{
		currentProjectId: string | null;
		projects: RuntimeProjectSummary[];
	}>;
	resolveWorkspaceForStream: (
		requestedWorkspaceId: string | null,
		options?: {
			onRemovedWorkspace?: (workspace: RemovedWorkspaceNotice) => void;
		},
	) => Promise<ResolvedWorkspaceStreamTarget>;
	listManagedWorkspaces: () => Array<{
		workspaceId: string;
		workspacePath: string | null;
		terminalManager: TerminalSessionManager;
	}>;
}

function createEmptyProjectTaskCounts(): RuntimeProjectTaskCounts {
	return {
		backlog: 0,
		in_progress: 0,
		review: 0,
		trash: 0,
	};
}

function countTasksByColumn(board: RuntimeBoardData): RuntimeProjectTaskCounts {
	const counts = createEmptyProjectTaskCounts();
	for (const column of board.columns) {
		const count = column.cards.length;
		switch (column.id) {
			case "backlog":
				counts.backlog += count;
				break;
			case "in_progress":
				counts.in_progress += count;
				break;
			case "review":
				counts.review += count;
				break;
			case "trash":
				counts.trash += count;
				break;
		}
	}
	return counts;
}

export function collectProjectWorktreeTaskIdsForRemoval(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function applyLiveSessionStateToProjectTaskCounts(
	counts: RuntimeProjectTaskCounts,
	board: RuntimeBoardData,
	sessionSummaries: RuntimeWorkspaceStateResponse["sessions"],
): RuntimeProjectTaskCounts {
	const taskColumnById = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskColumnById.set(card.id, column.id);
		}
	}
	const next = {
		...counts,
	};
	for (const summary of Object.values(sessionSummaries)) {
		const columnId = taskColumnById.get(summary.taskId);
		if (!columnId) {
			continue;
		}
		if (summary.state === "awaiting_review" && columnId === "in_progress") {
			next.in_progress = Math.max(0, next.in_progress - 1);
			next.review += 1;
			continue;
		}
		if (summary.state === "interrupted" && columnId !== "trash") {
			next[columnId] = Math.max(0, next[columnId] - 1);
			next.trash += 1;
		}
	}
	return next;
}

function toProjectSummary(project: {
	workspaceId: string;
	repoPath: string;
	taskCounts: RuntimeProjectTaskCounts;
}): RuntimeProjectSummary {
	const normalized = project.repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	const name = segments[segments.length - 1] ?? normalized;
	return {
		id: project.workspaceId,
		path: project.repoPath,
		name,
		taskCounts: project.taskCounts,
	};
}

export async function createWorkspaceRegistry(deps: CreateWorkspaceRegistryDependencies): Promise<WorkspaceRegistry> {
	const launchedFromGitRepo = deps.hasGitRepository(deps.cwd);
	const initialWorkspace = launchedFromGitRepo ? await loadWorkspaceContext(deps.cwd) : null;
	let indexedWorkspace: RuntimeWorkspaceIndexEntry | null = null;
	if (!initialWorkspace) {
		const indexedWorkspaces = await listWorkspaceIndexEntries();
		indexedWorkspace = indexedWorkspaces[0] ?? null;
	}

	let activeWorkspaceId: string | null = initialWorkspace?.workspaceId ?? indexedWorkspace?.workspaceId ?? null;
	let activeWorkspacePath: string | null = initialWorkspace?.repoPath ?? indexedWorkspace?.repoPath ?? null;
	let globalRuntimeConfig = await deps.loadGlobalRuntimeConfig();
	let activeRuntimeConfig = activeWorkspacePath
		? await deps.loadRuntimeConfig(activeWorkspacePath)
		: globalRuntimeConfig;
	const workspacePathsById = new Map<string, string>(
		activeWorkspaceId && activeWorkspacePath ? [[activeWorkspaceId, activeWorkspacePath]] : [],
	);
	const projectTaskCountsByWorkspaceId = new Map<string, RuntimeProjectTaskCounts>();
	const terminalManagersByWorkspaceId = new Map<string, TerminalSessionManager>();
	const terminalManagerLoadPromises = new Map<string, Promise<TerminalSessionManager>>();

	const rememberWorkspace = (workspaceId: string, repoPath: string): void => {
		workspacePathsById.set(workspaceId, repoPath);
	};

	const notifyTerminalManagerReady = (workspaceId: string, manager: TerminalSessionManager): void => {
		deps.onTerminalManagerReady?.(workspaceId, manager);
	};

	const getTerminalManagerForWorkspace = (workspaceId: string): TerminalSessionManager | null => {
		return terminalManagersByWorkspaceId.get(workspaceId) ?? null;
	};

	const ensureTerminalManagerForWorkspace = async (
		workspaceId: string,
		repoPath: string,
	): Promise<TerminalSessionManager> => {
		rememberWorkspace(workspaceId, repoPath);
		const existing = terminalManagersByWorkspaceId.get(workspaceId);
		if (existing) {
			notifyTerminalManagerReady(workspaceId, existing);
			return existing;
		}
		const pending = terminalManagerLoadPromises.get(workspaceId);
		if (pending) {
			const loaded = await pending;
			notifyTerminalManagerReady(workspaceId, loaded);
			return loaded;
		}
		const loading = (async () => {
			// Lazy `manager` binding so the onSessionExited closure can call
			// back into the same manager once it's been created below.
			let createdManager: TerminalSessionManager;
			const manager = new TerminalSessionManager({
				onSessionExited: (taskId, summary) => {
					// Two-phase delegation handoff: when the planner agent's
					// PTY exits and `.kanban-plan.md` exists in the worktree,
					// respawn the same card with the executor agent and the
					// plan content as prompt. We do this here (not just in
					// the to_review hook) because claude exits fast after
					// ExitPlanMode — the Stop hook often races the teardown
					// and `canTransitionTaskForHookEvent` blocks it.
					void (async () => {
						try {
							const board = await loadWorkspaceBoardById(workspaceId);
							const card = board?.columns.flatMap((column) => column.cards).find((c) => c.id === taskId);
							if (!card?.planAgentId) return;
							if (summary.agentId !== card.planAgentId) return;
							const pathInfo = await getTaskWorkspacePathInfo({
								cwd: repoPath,
								taskId,
								baseRef: card.baseRef,
							});
							if (!pathInfo.exists) return;
							const next = resolveTwoPhasePlan(card, pathInfo.path);
							if (!next || next.phase !== "exec") return;
							const runtimeConfig = await deps.loadRuntimeConfig(repoPath);
							const resolvedConfig =
								runtimeConfig.selectedAgentId === next.agentId
									? runtimeConfig
									: { ...runtimeConfig, selectedAgentId: next.agentId };
							const resolved = resolveAgentCommand(resolvedConfig);
							if (!resolved) return;
							await createdManager.startTaskSession({
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
							// Persist the executor's session record to disk and move the
							// card back to in_progress. Two distinct bugs without this:
							//   1. The planner's Stop hook likely already moved the card
							//      to review (hooks-api.ts) and possibly armed auto-review.
							//      Until the executor emits a fresh PreToolUse, the UI
							//      shows Review with the auto-commit prompt visible — yet
							//      the executor PTY is silently running. Move the card
							//      back so the user sees the correct state immediately.
							//   2. `startTaskSession` only updates the manager's in-memory
							//      entry. sessions.json on disk still references the
							//      planner agent (or has no entry at all if the planner
							//      session never persisted). On the next kanban restart
							//      auto-resume reads sessions.json, can't find the live
							//      executor, and either spawns a fresh session (losing
							//      the executor's chat history) or shows it as stopped.
							const executorSummary = createdManager.getSummary(taskId);
							if (executorSummary) {
								try {
									await mutateWorkspaceState(repoPath, (latestState) => {
										const movement = moveTaskToColumn(latestState.board, taskId, "in_progress", Date.now());
										const nextBoard = movement.moved ? movement.board : latestState.board;
										const nextSessions = { ...latestState.sessions, [taskId]: executorSummary };
										return { board: nextBoard, sessions: nextSessions, value: {} };
									});
								} catch {
									// Best effort: persistence failure should not abort the
									// handoff. The executor is already running; the worst
									// case is sessions.json staleness until the next state
									// mutation flushes it.
								}
							}
						} catch {
							// Best effort: log via console? swallow for now.
						}
					})();
				},
			});
			createdManager = manager;
			try {
				const existingWorkspace = await loadWorkspaceState(repoPath);
				manager.hydrateFromRecord(existingWorkspace.sessions);
			} catch {
				// Workspace state will be created on demand.
			}
			terminalManagersByWorkspaceId.set(workspaceId, manager);
			return manager;
		})().finally(() => {
			terminalManagerLoadPromises.delete(workspaceId);
		});
		terminalManagerLoadPromises.set(workspaceId, loading);
		const loaded = await loading;
		notifyTerminalManagerReady(workspaceId, loaded);
		return loaded;
	};

	const setActiveWorkspace = async (workspaceId: string, repoPath: string): Promise<void> => {
		activeWorkspaceId = workspaceId;
		activeWorkspacePath = repoPath;
		rememberWorkspace(workspaceId, repoPath);
		await ensureTerminalManagerForWorkspace(workspaceId, repoPath);
		activeRuntimeConfig = await deps.loadRuntimeConfig(repoPath);
		globalRuntimeConfig = toGlobalRuntimeConfigState(activeRuntimeConfig);
	};

	const clearActiveWorkspace = (): void => {
		activeWorkspaceId = null;
		activeWorkspacePath = null;
		activeRuntimeConfig = globalRuntimeConfig;
	};

	const disposeWorkspace = (
		workspaceId: string,
		options?: DisposeWorkspaceRegistryOptions,
	): { terminalManager: TerminalSessionManager | null; workspacePath: string | null } => {
		const terminalManager = getTerminalManagerForWorkspace(workspaceId);
		if (terminalManager) {
			if (options?.stopTerminalSessions !== false) {
				terminalManager.markInterruptedAndStopAll();
			}
			terminalManagersByWorkspaceId.delete(workspaceId);
			terminalManagerLoadPromises.delete(workspaceId);
		}
		projectTaskCountsByWorkspaceId.delete(workspaceId);
		const workspacePath = workspacePathsById.get(workspaceId) ?? null;
		workspacePathsById.delete(workspaceId);
		return {
			terminalManager,
			workspacePath,
		};
	};

	const summarizeProjectTaskCounts = async (
		workspaceId: string,
		_repoPath: string,
	): Promise<RuntimeProjectTaskCounts> => {
		try {
			const board = await loadWorkspaceBoardById(workspaceId);
			const persistedCounts = countTasksByColumn(board);
			const terminalManager = getTerminalManagerForWorkspace(workspaceId);
			if (!terminalManager) {
				projectTaskCountsByWorkspaceId.set(workspaceId, persistedCounts);
				return persistedCounts;
			}
			const liveSessionsByTaskId: RuntimeWorkspaceStateResponse["sessions"] = {};
			for (const summary of terminalManager.listSummaries()) {
				liveSessionsByTaskId[summary.taskId] = summary;
			}
			const nextCounts = applyLiveSessionStateToProjectTaskCounts(persistedCounts, board, liveSessionsByTaskId);
			projectTaskCountsByWorkspaceId.set(workspaceId, nextCounts);
			return nextCounts;
		} catch {
			return projectTaskCountsByWorkspaceId.get(workspaceId) ?? createEmptyProjectTaskCounts();
		}
	};

	const buildWorkspaceStateSnapshot = async (
		workspaceId: string,
		workspacePath: string,
	): Promise<RuntimeWorkspaceStateResponse> => {
		const response = await loadWorkspaceState(workspacePath);
		const terminalManager = await ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
		for (const summary of terminalManager.listSummaries()) {
			response.sessions[summary.taskId] = summary;
		}
		return response;
	};

	const buildProjectsPayload = async (preferredCurrentProjectId: string | null) => {
		const projects = await listWorkspaceIndexEntries();
		const fallbackProjectId =
			projects.find((project) => project.workspaceId === activeWorkspaceId)?.workspaceId ??
			projects[0]?.workspaceId ??
			null;
		const resolvedCurrentProjectId =
			(preferredCurrentProjectId &&
				projects.some((project) => project.workspaceId === preferredCurrentProjectId) &&
				preferredCurrentProjectId) ||
			fallbackProjectId;
		const projectSummaries = await Promise.all(
			projects.map(async (project) => {
				const taskCounts = await summarizeProjectTaskCounts(project.workspaceId, project.repoPath);
				return toProjectSummary({
					workspaceId: project.workspaceId,
					repoPath: project.repoPath,
					taskCounts,
				});
			}),
		);
		return {
			currentProjectId: resolvedCurrentProjectId,
			projects: projectSummaries,
		};
	};

	const resolveWorkspaceForStream = async (
		requestedWorkspaceId: string | null,
		options?: {
			onRemovedWorkspace?: (workspace: RemovedWorkspaceNotice) => void;
		},
	): Promise<ResolvedWorkspaceStreamTarget> => {
		const allProjects = await listWorkspaceIndexEntries();
		const existingProjects: RuntimeWorkspaceIndexEntry[] = [];
		const removedProjects: RuntimeWorkspaceIndexEntry[] = [];

		for (const project of allProjects) {
			let removalMessage: string | null = null;
			if (!(await deps.pathIsDirectory(project.repoPath))) {
				removalMessage = `Project no longer exists on disk and was removed: ${project.repoPath}`;
			} else if (!deps.hasGitRepository(project.repoPath)) {
				removalMessage = `Project is not a git repository and was removed: ${project.repoPath}`;
			}

			if (!removalMessage) {
				existingProjects.push(project);
				continue;
			}

			removedProjects.push(project);
			await removeWorkspaceIndexEntry(project.workspaceId);
			await removeWorkspaceStateFiles(project.workspaceId);
			disposeWorkspace(project.workspaceId);
			options?.onRemovedWorkspace?.({
				workspaceId: project.workspaceId,
				repoPath: project.repoPath,
				message: removalMessage,
			});
		}

		const removedRequestedWorkspacePath = requestedWorkspaceId
			? (removedProjects.find((project) => project.workspaceId === requestedWorkspaceId)?.repoPath ?? null)
			: null;

		const activeWorkspaceMissing = !existingProjects.some((project) => project.workspaceId === activeWorkspaceId);
		if (activeWorkspaceMissing) {
			if (existingProjects[0]) {
				await setActiveWorkspace(existingProjects[0].workspaceId, existingProjects[0].repoPath);
			} else {
				clearActiveWorkspace();
			}
		}

		if (requestedWorkspaceId) {
			const requestedWorkspace = existingProjects.find((project) => project.workspaceId === requestedWorkspaceId);
			if (requestedWorkspace) {
				if (
					activeWorkspaceId !== requestedWorkspace.workspaceId ||
					activeWorkspacePath !== requestedWorkspace.repoPath
				) {
					await setActiveWorkspace(requestedWorkspace.workspaceId, requestedWorkspace.repoPath);
				}
				return {
					workspaceId: requestedWorkspace.workspaceId,
					workspacePath: requestedWorkspace.repoPath,
					removedRequestedWorkspacePath,
					didPruneProjects: removedProjects.length > 0,
				};
			}
		}

		const fallbackWorkspace =
			existingProjects.find((project) => project.workspaceId === activeWorkspaceId) ?? existingProjects[0] ?? null;
		if (!fallbackWorkspace) {
			return {
				workspaceId: null,
				workspacePath: null,
				removedRequestedWorkspacePath,
				didPruneProjects: removedProjects.length > 0,
			};
		}
		return {
			workspaceId: fallbackWorkspace.workspaceId,
			workspacePath: fallbackWorkspace.repoPath,
			removedRequestedWorkspacePath,
			didPruneProjects: removedProjects.length > 0,
		};
	};

	if (initialWorkspace) {
		await ensureTerminalManagerForWorkspace(initialWorkspace.workspaceId, initialWorkspace.repoPath);
	}

	return {
		getActiveWorkspaceId: () => activeWorkspaceId,
		getActiveWorkspacePath: () => activeWorkspacePath,
		getWorkspacePathById: (workspaceId: string) => workspacePathsById.get(workspaceId) ?? null,
		rememberWorkspace,
		getActiveRuntimeConfig: () => activeRuntimeConfig,
		setActiveRuntimeConfig: (config: RuntimeConfigState) => {
			globalRuntimeConfig = toGlobalRuntimeConfigState(config);
			activeRuntimeConfig = activeWorkspaceId ? config : globalRuntimeConfig;
		},
		loadScopedRuntimeConfig: async (scope: WorkspaceRegistryScope) => {
			if (scope.workspaceId === activeWorkspaceId) {
				return activeRuntimeConfig;
			}
			return await deps.loadRuntimeConfig(scope.workspacePath);
		},
		getTerminalManagerForWorkspace,
		ensureTerminalManagerForWorkspace,
		setActiveWorkspace,
		clearActiveWorkspace,
		disposeWorkspace,
		summarizeProjectTaskCounts,
		createProjectSummary: toProjectSummary,
		buildWorkspaceStateSnapshot,
		buildProjectsPayload,
		resolveWorkspaceForStream,
		listManagedWorkspaces: () => {
			return Array.from(terminalManagersByWorkspaceId.entries()).map(([workspaceId, terminalManager]) => ({
				workspaceId,
				workspacePath: workspacePathsById.get(workspaceId) ?? null,
				terminalManager,
			}));
		},
	};
}
