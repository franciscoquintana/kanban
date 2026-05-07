// Auto-resume in_progress tasks at kanban startup.
//
// When kanban restarts, every per-task agent process (e.g. claude-code spawned
// for each in_progress task) gets killed because the agents are children of
// the kanban server process. Their worktrees and chat history persist on disk,
// but upstream kanban does NOT auto-respawn them — the user has to click Play
// on each card.
//
// This module relaunches every in_progress task whose persisted session is
// not already running, with `resume: true` (so claude resumes via
// `--continue`) and `prompt: ""` (so the user decides what to type next).
//
// Scope: only `claude` is supported in this commit. Tasks running on other
// agents (codex, droid, kiro, gemini, opencode) are left alone — the user
// will have to click Play manually for those, like upstream behaviour.
// Cline native is also skipped because the ClineTaskSessionService manages
// its own resume flow and we don't want to step on it.
//
// Opt-out: set `KANBAN_DISABLE_AUTO_RESUME=true` to skip the entire pass.
//
// See `.plan/docs/fork-server-side-auto-review.md`.

import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceSessionsById,
} from "../state/workspace-state.js";
import { resolveAgentCommand } from "../terminal/agent-registry.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree.js";
import { logError, logInfo } from "./server-log.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

const STAGGER_BETWEEN_SPAWNS_MS = 500;
const SUPPORTED_AGENT_ID = "claude" as const;

function isOptOutSet(): boolean {
	const raw = process.env.KANBAN_DISABLE_AUTO_RESUME?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResumeInProgressTasksDeps {
	workspaceRegistry: Pick<WorkspaceRegistry, "loadScopedRuntimeConfig">;
	// Forces creation of the per-workspace terminal manager (which spawns
	// per-task agent processes). Workspaces are loaded lazily by kanban; for
	// auto-resume we need to ensure the manager exists for every workspace
	// that has in_progress work even if the user hasn't navigated there yet.
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
}

/**
 * Iterate every managed workspace at boot and relaunch each in_progress task
 * whose persisted session is not already running. Only claude tasks are
 * resumed; other agents are skipped. Errors per task are logged and never
 * abort the rest of the pass.
 *
 * Returns when all spawn attempts have been issued. Each spawn is staggered
 * by `STAGGER_BETWEEN_SPAWNS_MS` to avoid a thundering-herd of agent
 * processes at startup.
 */
export async function resumeInProgressTasksOnBoot(deps: ResumeInProgressTasksDeps): Promise<void> {
	if (isOptOutSet()) {
		logInfo("[auto-resume] skipped (KANBAN_DISABLE_AUTO_RESUME)");
		return;
	}

	// Use the persisted workspace index, not just the workspaces currently
	// managed in memory. At boot the registry is empty until something (the
	// browser, a CLI command) touches a workspace; we want to scan everything
	// that was ever registered.
	const entries = await listWorkspaceIndexEntries();
	if (entries.length === 0) {
		return;
	}

	let totalCandidates = 0;

	for (const entry of entries) {
		try {
			const terminalManager = await deps.ensureTerminalManagerForWorkspace(entry.workspaceId, entry.repoPath);
			await resumeWorkspace({
				workspaceId: entry.workspaceId,
				workspacePath: entry.repoPath,
				terminalManager,
				loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
				onCandidateCount: (count) => {
					totalCandidates += count;
				},
			});
		} catch (err) {
			logError(`[auto-resume] workspace ${entry.workspaceId} failed`, err);
		}
	}

	if (totalCandidates > 0) {
		logInfo(`[auto-resume] pass complete (${totalCandidates} task(s) processed)`);
	}
}

interface ResumeWorkspaceInput {
	workspaceId: string;
	workspacePath: string;
	terminalManager: TerminalSessionManager;
	loadScopedRuntimeConfig: WorkspaceRegistry["loadScopedRuntimeConfig"];
	onCandidateCount: (count: number) => void;
}

async function resumeWorkspace(input: ResumeWorkspaceInput): Promise<void> {
	const board = await loadWorkspaceBoardById(input.workspaceId);
	const sessions = await loadWorkspaceSessionsById(input.workspaceId);
	// Resume agents for tasks in either `in_progress` or `review`. Tasks in
	// review may still need their agent alive for follow-up edits or to drive
	// the auto-commit pipeline; backlog/done are intentionally excluded.
	const resumableColumns = new Set<string>(["in_progress", "review"]);
	const allCards = board.columns.filter((column) => resumableColumns.has(column.id)).flatMap((column) => column.cards);
	const candidates = allCards.filter((card) => {
		// At boot time, any process kanban spawned in its previous lifetime is
		// dead (children of a parent process that no longer exists). The
		// persisted `state` field in sessions.json is therefore stale —
		// including the "running" entries. Trust the column position instead:
		// any card in `in_progress`/`review` with a session record needs respawn.
		// Cards without a session record (clean board) are skipped because
		// `claude --continue` would fail with "No conversations to continue".
		return sessions[card.id] !== undefined;
	});
	input.onCandidateCount(candidates.length);
	if (candidates.length === 0) {
		return;
	}
	logInfo(`[auto-resume] workspace ${input.workspaceId}: resuming ${candidates.length} task(s)`);

	const runtimeConfig = await input.loadScopedRuntimeConfig({
		workspaceId: input.workspaceId,
		workspacePath: input.workspacePath,
	});

	for (let index = 0; index < candidates.length; index += 1) {
		const card = candidates[index];
		if (!card) {
			continue;
		}
		const summary = sessions[card.id];
		// Order: per-task override (card.agentId) > previous run (summary.agentId) > workspace default.
		const effectiveAgentId = card.agentId ?? summary?.agentId ?? runtimeConfig.selectedAgentId;
		if (effectiveAgentId !== SUPPORTED_AGENT_ID) {
			logInfo(
				`[auto-resume] task ${card.id} skipped (agent=${effectiveAgentId}, only ${SUPPORTED_AGENT_ID} supported)`,
			);
			continue;
		}

		try {
			await spawnOne({
				workspaceId: input.workspaceId,
				workspacePath: input.workspacePath,
				terminalManager: input.terminalManager,
				runtimeConfig,
				taskId: card.id,
				baseRef: card.baseRef,
				startInPlanMode: card.startInPlanMode,
			});
		} catch (err) {
			logError(`[auto-resume] task ${card.id} failed to spawn`, err);
		}

		if (index < candidates.length - 1) {
			await delay(STAGGER_BETWEEN_SPAWNS_MS);
		}
	}
}

interface SpawnOneInput {
	workspaceId: string;
	workspacePath: string;
	terminalManager: TerminalSessionManager;
	runtimeConfig: Parameters<typeof resolveAgentCommand>[0];
	taskId: string;
	baseRef: string;
	startInPlanMode?: boolean;
}

async function spawnOne(input: SpawnOneInput): Promise<void> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: input.workspacePath,
		taskId: input.taskId,
		baseRef: input.baseRef,
	});
	if (!pathInfo.exists) {
		logInfo(`[auto-resume] task ${input.taskId} skipped (worktree missing at ${pathInfo.path})`);
		return;
	}
	// Force the resolved config to use claude regardless of the current
	// runtime selection (we already filtered above, but in_progress tasks
	// might have been started with a per-card override that no longer
	// matches the workspace default).
	const resolvedConfig =
		input.runtimeConfig.selectedAgentId === SUPPORTED_AGENT_ID
			? input.runtimeConfig
			: { ...input.runtimeConfig, selectedAgentId: SUPPORTED_AGENT_ID };
	const resolved = resolveAgentCommand(resolvedConfig, { resume: true });
	if (!resolved) {
		logInfo(`[auto-resume] task ${input.taskId} skipped (no runnable claude binary on PATH)`);
		return;
	}
	await input.terminalManager.startTaskSession({
		taskId: input.taskId,
		agentId: resolved.agentId,
		binary: resolved.binary,
		args: resolved.args,
		autonomousModeEnabled: resolvedConfig.agentAutonomousModeEnabled,
		cwd: pathInfo.path,
		// Empty kickoff prompt: claude --continue restores prior chat; the
		// user decides what to send next via the UI.
		prompt: "",
		startInPlanMode: input.startInPlanMode,
		workspaceId: input.workspaceId,
	});
	logInfo(`[auto-resume] task ${input.taskId} spawned with resume=true`);
}
