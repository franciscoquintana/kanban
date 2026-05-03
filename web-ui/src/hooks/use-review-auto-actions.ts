// In this fork, server-side auto-review (`src/server/server-auto-review-manager.ts`)
// owns the dispatch of auto-commit and auto-trash. The frontend hook below is
// a pure observer: when the server announces an upcoming programmatic move
// via the `auto_action_pending` WebSocket message, the hook plays the local
// card animation so the move is smooth in the UI rather than a hard jump.
//
// Manual UI buttons (Commit / Open PR / Move to Trash on each card) keep using
// `runAutoReviewGitAction` and `requestMoveTaskToTrashWithAnimation` directly
// from `use-git-actions.ts` and `use-board-interactions.ts` — those are
// untouched.
//
// See `.plan/docs/fork-server-side-auto-review.md`.
import { useEffect, useRef } from "react";

import type { RuntimeStateStreamAutoActionPendingMessage } from "@/runtime/types";
import type { BoardColumnId, BoardData } from "@/types";

interface ProgrammaticCardMoveBehavior {
	insertAtTop?: boolean;
	skipWorkingChangeWarning?: boolean;
}

interface UseReviewAutoActionsOptions {
	board: BoardData;
	latestAutoActionPending: RuntimeStateStreamAutoActionPendingMessage | null;
	tryProgrammaticCardMove: (
		taskId: string,
		fromColumnId: BoardColumnId,
		targetColumnId: BoardColumnId,
		behavior?: ProgrammaticCardMoveBehavior,
	) => "started" | "blocked" | "unavailable";
	resetKey?: string | null;
}

export function useReviewAutoActions({
	board,
	latestAutoActionPending,
	tryProgrammaticCardMove,
	resetKey,
}: UseReviewAutoActionsOptions): void {
	const boardRef = useRef<BoardData>(board);
	const tryProgrammaticCardMoveRef = useRef(tryProgrammaticCardMove);
	// Track which auto-action payload identities we've already animated. The
	// stream stores the latest message in state, so without this guard a
	// re-render would re-trigger the animation.
	const lastHandledRef = useRef<RuntimeStateStreamAutoActionPendingMessage | null>(null);

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	useEffect(() => {
		tryProgrammaticCardMoveRef.current = tryProgrammaticCardMove;
	}, [tryProgrammaticCardMove]);

	useEffect(() => {
		// Reset memory when switching projects (or whenever the caller bumps the key).
		lastHandledRef.current = null;
	}, [resetKey]);

	useEffect(() => {
		if (!latestAutoActionPending) {
			return;
		}
		if (lastHandledRef.current === latestAutoActionPending) {
			return;
		}
		lastHandledRef.current = latestAutoActionPending;

		if (latestAutoActionPending.action !== "move_to_trash") {
			return;
		}

		const taskId = latestAutoActionPending.taskId;
		const fromColumnId = latestAutoActionPending.fromColumnId;

		// Defensive sanity check: only animate when the card is still in the
		// expected source column locally. If the local board is already past
		// it (race) we just skip — the upcoming workspace_state_updated will
		// still settle the visual state.
		const stillInSource = boardRef.current.columns
			.find((column) => column.id === fromColumnId)
			?.cards.some((card) => card.id === taskId);
		if (!stillInSource) {
			return;
		}

		// "blocked" / "unavailable" both mean the dnd context isn't ready or
		// another programmatic move is in flight. Either way we skip — the
		// state update from the server still reaches the board.
		tryProgrammaticCardMoveRef.current(taskId, fromColumnId, "trash", {
			insertAtTop: true,
			skipWorkingChangeWarning: true,
		});
	}, [latestAutoActionPending]);
}
