// Renders the `.kanban-plan.md` artefact for two-phase delegation cards.
//
// A card with `planAgentId` runs in two phases: the planner agent writes its
// final implementation plan to `.kanban-plan.md` in the worktree, then the
// executor agent takes over. The plan file persists, so we render it as a
// markdown block above the live exec PTY — the user keeps full visibility of
// the planner's decisions even after the planner PTY is gone.
//
// Polls `runtime.getTaskPlanFile` every 5s while the card is active and the
// file is still missing. Stops polling once the file appears (its contents do
// not change after the planner exits plan mode).

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ClineMarkdownContent } from "@/components/detail-panels/cline-markdown-content";
import { cn } from "@/components/ui/cn";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

const POLL_INTERVAL_MS = 5000;

interface PlanArtifactPanelProps {
	taskId: string;
	workspaceId: string;
	/**
	 * When true the panel polls the runtime for the plan file every 5s. Set
	 * by the parent to e.g. `summary.state === "running"` so we only poll
	 * while the planner is alive.
	 */
	isCardActive: boolean;
}

export function PlanArtifactPanel({ taskId, workspaceId, isCardActive }: PlanArtifactPanelProps): ReactElement {
	const queryFn = useCallback(async () => {
		const trpc = getRuntimeTrpcClient(workspaceId);
		return await trpc.runtime.getTaskPlanFile.query({ taskId });
	}, [taskId, workspaceId]);

	const { data, isLoading, isError, refetch } = useTrpcQuery({
		enabled: true,
		queryFn,
	});

	const planExists = data?.exists === true;
	const planContent = data?.exists === true ? data.content : "";
	const [isCollapsed, setIsCollapsed] = useState(false);

	// Poll while the card is active AND the plan file is still missing.
	// Once it appears we can stop — the planner does not rewrite it.
	const intervalRef = useRef<number | null>(null);
	useEffect(() => {
		if (!isCardActive || planExists) {
			if (intervalRef.current !== null) {
				window.clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
			return;
		}
		intervalRef.current = window.setInterval(() => {
			void refetch();
		}, POLL_INTERVAL_MS);
		return () => {
			if (intervalRef.current !== null) {
				window.clearInterval(intervalRef.current);
				intervalRef.current = null;
			}
		};
	}, [isCardActive, planExists, refetch]);

	const modifiedAtLabel = useMemo(() => {
		if (data?.exists !== true) return null;
		try {
			return new Date(data.modifiedAt).toLocaleString();
		} catch {
			return null;
		}
	}, [data]);

	return (
		<section className="mb-2 flex flex-col rounded-md border border-border bg-[var(--color-surface-1)]">
			<button
				type="button"
				onClick={() => setIsCollapsed((prev) => !prev)}
				className={cn(
					"flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-text-secondary",
					"hover:bg-[var(--color-surface-2)]",
				)}
			>
				<span className="flex items-center gap-2">
					<span aria-hidden>{isCollapsed ? "▶" : "▼"}</span>
					<span>Plan (planner agent)</span>
					{planExists ? (
						<span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
							ready
						</span>
					) : (
						<span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide opacity-60">
							pending
						</span>
					)}
				</span>
				{modifiedAtLabel && <span className="text-[10px] text-text-tertiary">{modifiedAtLabel}</span>}
			</button>

			{!isCollapsed && (
				<div className="max-h-[40vh] overflow-y-auto border-t border-border px-3 py-2 text-sm">
					{planExists ? (
						<ClineMarkdownContent content={planContent} />
					) : (
						<div className="flex items-center gap-2 py-3 text-xs text-text-tertiary">
							{isLoading ? (
								<span>Loading plan…</span>
							) : isError ? (
								<span>Could not read plan file. Will retry.</span>
							) : (
								<span>
									Waiting for the planner agent to write <code className="font-mono">.kanban-plan.md</code>…
								</span>
							)}
						</div>
					)}
				</div>
			)}
		</section>
	);
}
