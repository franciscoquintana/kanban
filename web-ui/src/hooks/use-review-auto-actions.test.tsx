import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { RuntimeStateStreamAutoActionPendingMessage } from "@/runtime/types";
import type { BoardColumnId, BoardData } from "@/types";

// In this fork the auto-review dispatch lives on the server. The hook we test
// here is a pure observer: when the server announces an upcoming programmatic
// move via `auto_action_pending`, the hook should play the local move
// animation by calling `tryProgrammaticCardMove`. See
// `.plan/docs/fork-server-side-auto-review.md`.

function createBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled: true,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function autoActionPending(taskId: string): RuntimeStateStreamAutoActionPendingMessage {
	return {
		type: "auto_action_pending",
		workspaceId: "ws-1",
		taskId,
		fromColumnId: "review",
		action: "move_to_trash",
	};
}

function HookHarness({
	board,
	latestAutoActionPending,
	tryProgrammaticCardMove,
}: {
	board: BoardData;
	latestAutoActionPending: RuntimeStateStreamAutoActionPendingMessage | null;
	tryProgrammaticCardMove: (
		taskId: string,
		fromColumnId: BoardColumnId,
		targetColumnId: BoardColumnId,
	) => "started" | "blocked" | "unavailable";
}): null {
	useReviewAutoActions({
		board,
		latestAutoActionPending,
		tryProgrammaticCardMove,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("does not call tryProgrammaticCardMove when no auto-action message has arrived", () => {
		const tryProgrammaticCardMove = vi.fn().mockReturnValue("started" as const);
		act(() => {
			root.render(
				<HookHarness
					board={createBoard()}
					latestAutoActionPending={null}
					tryProgrammaticCardMove={tryProgrammaticCardMove}
				/>,
			);
		});
		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();
	});

	it("plays the move animation when auto_action_pending arrives for a task in review", () => {
		const tryProgrammaticCardMove = vi.fn().mockReturnValue("started" as const);
		const message = autoActionPending("task-1");
		act(() => {
			root.render(
				<HookHarness
					board={createBoard()}
					latestAutoActionPending={message}
					tryProgrammaticCardMove={tryProgrammaticCardMove}
				/>,
			);
		});
		expect(tryProgrammaticCardMove).toHaveBeenCalledTimes(1);
		expect(tryProgrammaticCardMove).toHaveBeenCalledWith(
			"task-1",
			"review",
			"trash",
			expect.objectContaining({ insertAtTop: true, skipWorkingChangeWarning: true }),
		);
	});

	it("does not re-trigger the animation on re-render with the same payload identity", () => {
		const tryProgrammaticCardMove = vi.fn().mockReturnValue("started" as const);
		const message = autoActionPending("task-1");
		act(() => {
			root.render(
				<HookHarness
					board={createBoard()}
					latestAutoActionPending={message}
					tryProgrammaticCardMove={tryProgrammaticCardMove}
				/>,
			);
		});
		act(() => {
			root.render(
				<HookHarness
					board={createBoard()}
					latestAutoActionPending={message}
					tryProgrammaticCardMove={tryProgrammaticCardMove}
				/>,
			);
		});
		expect(tryProgrammaticCardMove).toHaveBeenCalledTimes(1);
	});

	it("skips the animation when the task is no longer in the source column", () => {
		const tryProgrammaticCardMove = vi.fn().mockReturnValue("started" as const);
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
		act(() => {
			root.render(
				<HookHarness
					board={board}
					latestAutoActionPending={autoActionPending("task-1")}
					tryProgrammaticCardMove={tryProgrammaticCardMove}
				/>,
			);
		});
		expect(tryProgrammaticCardMove).not.toHaveBeenCalled();
	});
});
