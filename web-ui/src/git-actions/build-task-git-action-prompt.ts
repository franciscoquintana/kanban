// This file is a thin re-export of the shared module that lives in the
// server-side `src/git-actions/`. The server-side auto-review manager and the
// frontend manual buttons both consume this same canonical implementation.
// See `.plan/docs/fork-server-side-auto-review.md`.
export {
	buildTaskGitActionPrompt,
	TASK_GIT_BASE_REF_PROMPT_VARIABLE,
	type TaskGitAction,
	type TaskGitPromptTemplates,
} from "@runtime-git-action-prompt";
