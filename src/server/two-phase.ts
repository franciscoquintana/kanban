// Two-phase delegation helpers.
//
// A card can declare `planAgentId` to run in two phases:
//   1. plan phase  → spawn `planAgentId` in `--permission-mode plan` with an
//      injected system prompt instructing it to write the final plan to
//      `.kanban-plan.md` inside the worktree.
//   2. exec phase  → spawn `agentId` (no plan mode) with the contents of
//      `.kanban-plan.md` as the prompt.
//
// The decision between phases is purely a function of "does the plan file
// exist in the worktree?". No runtime phase state is needed.
//
// See `docs/openclaude-agent.md`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract.js";

/**
 * A plan file is "stale" when it's tracked by git (i.e. inherited from a
 * branch tip, not produced by THIS card's planner). This happens when an
 * earlier card's executor accidentally staged its plan file and committed
 * it; subsequent worktrees created from that branch tip silently inherit
 * the wrong plan and run the wrong work.
 *
 * Real planner output is always untracked (the worktree's .gitignore should
 * have `.kanban-plan.md` listed, but even when it doesn't, the planner
 * doesn't `git add` the sentinel).
 */
function isStalePlanFile(worktreePath: string): boolean {
	try {
		const result = execFileSync("git", ["-C", worktreePath, "ls-files", "--", PLAN_FILE_NAME], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return result.trim().length > 0;
	} catch {
		return false;
	}
}

export const PLAN_FILE_NAME = ".kanban-plan.md";

/**
 * Sentinel file an executor writes when it has emitted a question to the user
 * and is waiting for a response. Auto-review checks for this file before
 * arming and skips the commit prompt while it exists.
 *
 * Lifecycle: the executor creates it before ending its turn with a question,
 * and removes it when the user's response arrives (next UserPromptSubmit).
 * Hook handlers do NOT auto-clean it — the agent owns the lifecycle so that
 * a question only disappears once the agent observes the user's answer.
 */
export const NEEDS_INPUT_FILE_NAME = ".kanban-needs-input";

/**
 * Sentinel an executor writes before kicking off a long-running background
 * subprocess (e.g. `Bash(python long_script.py &)`). The Bash tool returns
 * immediately because of `&`, so the agent often emits `Stop` next — which
 * would otherwise move the card to Review while the subprocess is still
 * working. While this file exists in the worktree root, hooks-api skips
 * the to_review transition and auto-review skips arming.
 *
 * Lifecycle: the executor creates it BEFORE running the background command
 * and removes it once the subprocess has finished (in a follow-up Bash
 * call or via the foreground command that observes the subprocess exit).
 */
export const BG_ACTIVE_FILE_NAME = ".kanban-bg-active";

export const PLAN_PHASE_SYSTEM_PROMPT_APPEND = `\n\n[KANBAN TWO-PHASE PLANNING]
You are running in plan mode for a kanban card. Your job is to PLAN, not to
implement. After investigating the repo and designing the change:

1. Write the FINAL detailed implementation plan as plain markdown into the file
   \`${PLAN_FILE_NAME}\` at the root of the current working directory. The plan
   must be self-contained — assume the next agent will execute it without
   reading the chat history. Include exact file paths, exact changes,
   acceptance criteria, and a "do NOT touch" list.

2. After writing the file, call ExitPlanMode to confirm you are done.

When the PTY exits and \`${PLAN_FILE_NAME}\` exists, kanban will automatically
re-spawn this card with the execution agent using your plan as the prompt.
If you do not write the file, the card moves to review as usual and no
execution phase runs.`;

export interface TwoPhasePlan {
	phase: "plan" | "exec";
	agentId: RuntimeAgentId;
	prompt: string;
	startInPlanMode: boolean;
	appendSystemPrompt?: string;
}

/**
 * Resolve which phase the next spawn should run given the card and the
 * current worktree state.
 *
 * - If `planAgentId` is unset → single-phase: use `agentId` with the card's
 *   original prompt. The card behaves like a normal kanban card.
 * - If `planAgentId` set and the plan file is missing → plan phase: use
 *   `planAgentId`, enter plan mode, append the planning system prompt.
 * - If `planAgentId` set and the plan file is present → exec phase: use
 *   `agentId`, no plan mode, prompt = plan file contents.
 *
 * Returns null when the card lacks any agentId (caller should fall back to
 * the workspace default selectedAgentId, as today).
 */
export function resolveTwoPhasePlan(card: RuntimeBoardCard, worktreePath: string): TwoPhasePlan | null {
	const execAgentId = card.agentId;
	const planAgentId = card.planAgentId;

	if (!planAgentId) {
		if (!execAgentId) return null;
		return {
			phase: "exec",
			agentId: execAgentId,
			prompt: card.prompt,
			startInPlanMode: card.startInPlanMode === true,
		};
	}

	const planFilePath = join(worktreePath, PLAN_FILE_NAME);
	// Detect stale plans inherited from the branch tip: a real planner-
	// produced plan is untracked. If git knows the file (ls-files non-empty)
	// it came from a commit on an upstream card and does NOT describe this
	// card's work — discard it and run the plan phase fresh.
	if (existsSync(planFilePath) && isStalePlanFile(worktreePath)) {
		try {
			unlinkSync(planFilePath);
		} catch {
			// Best effort: even if removal fails, treating the file as absent
			// below is safer than feeding the wrong plan to the executor.
		}
	}
	if (!existsSync(planFilePath)) {
		return {
			phase: "plan",
			agentId: planAgentId,
			prompt: `${card.prompt}${PLAN_PHASE_SYSTEM_PROMPT_APPEND}`,
			startInPlanMode: true,
		};
	}

	const planContent = safeReadFile(planFilePath);
	if (!planContent) {
		// Plan file exists but empty/unreadable → fall back to plan phase.
		return {
			phase: "plan",
			agentId: planAgentId,
			prompt: `${card.prompt}${PLAN_PHASE_SYSTEM_PROMPT_APPEND}`,
			startInPlanMode: true,
		};
	}

	if (!execAgentId) {
		// Plan file exists but no exec agent declared → nothing to do.
		return null;
	}

	return {
		phase: "exec",
		agentId: execAgentId,
		prompt: `[KANBAN TWO-PHASE EXECUTION]
You received the following implementation plan from the planning phase. Execute it precisely as described.

If the plan is ambiguous, missing critical info, or requires a choice you do not feel safe making on your own, DO NOT make assumptions and DO NOT commit a half-decision. Instead, before you end your turn:

1. State the question clearly in your final message so the user can read it.
2. Write an empty file at the worktree root named \`${NEEDS_INPUT_FILE_NAME}\` — this signals kanban to skip the auto-commit prompt and wait for the user's reply. Without this sentinel, kanban will inject the auto-commit prompt over your question and ship a default decision.
3. When the user responds (you receive a new user message), delete \`${NEEDS_INPUT_FILE_NAME}\` and continue with their guidance.

If you need to launch a long-running background process (e.g. \`python long_script.py &\`, \`nohup ... &\`, anything that returns immediately while a subprocess keeps working), use the \`${BG_ACTIVE_FILE_NAME}\` sentinel:

1. \`touch ${BG_ACTIVE_FILE_NAME}\` IMMEDIATELY before launching the background command.
2. The PTY Bash tool returns fast because of \`&\` — without the sentinel, kanban interprets your next Stop as "work finished" and moves the card to review. The sentinel tells kanban to wait.
3. When the subprocess has finished (poll it, wait for a log line, whatever), \`rm ${BG_ACTIVE_FILE_NAME}\` and then end your turn. Only then will auto-review consider the card complete.

----- PLAN -----
${planContent.trim()}
----- END PLAN -----`,
		startInPlanMode: false,
	};
}

function safeReadFile(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
