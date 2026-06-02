import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
	RuntimeGitCheckoutResponse,
	RuntimeGitDiscardResponse,
	RuntimeGitSyncAction,
	RuntimeGitSyncResponse,
	RuntimeGitSyncSummary,
} from "../core/api-contract";
import { BG_ACTIVE_FILE_NAME, NEEDS_INPUT_FILE_NAME, PLAN_FILE_NAME } from "../server/two-phase";
import { runGit } from "./git-utils";

// Kanban runtime sentinels that should NEVER count toward changedFiles.
// These are kanban-internal artifacts (per-task plan, "agent needs user input"
// marker) — counting them poisons the auto-review state machine:
//   * if they appear untracked, evaluate() never disarms ("agent still has
//     pending work")
//   * if they appear as deletions of a tracked file (legacy: T15 leaked
//     .kanban-plan.md into a commit), evaluate() fires the commit prompt at
//     a planner that can't commit in plan mode, leaving the card stuck
const KANBAN_RUNTIME_SENTINELS: ReadonlySet<string> = new Set([
	PLAN_FILE_NAME,
	NEEDS_INPUT_FILE_NAME,
	BG_ACTIVE_FILE_NAME,
]);

/**
 * Resolve the tip commit SHA of a local branch in `repoPath`. Returns `null`
 * if the branch does not exist locally (e.g. only as a remote-tracking ref).
 *
 * Used by the server-side auto-review manager to capture a baseline at arming
 * time and verify after a commit that the branch advanced — i.e. the
 * cherry-pick onto `baseRef` actually succeeded. See
 * `.plan/docs/fork-server-side-auto-review.md`.
 */
export async function getBranchTip(repoPath: string, baseRef: string): Promise<string | null> {
	const trimmed = baseRef.trim();
	if (!trimmed) {
		return null;
	}
	const result = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${trimmed}^{commit}`]);
	if (!result.ok) {
		return null;
	}
	const sha = result.stdout.trim();
	return sha.length > 0 ? sha : null;
}

/**
 * Count commits reachable from HEAD that are NOT reachable from baseRef
 * (i.e. local commits in the worktree that have not been merged/cherry-picked
 * onto baseRef yet). Returns null if the command fails (worktree missing,
 * baseRef missing, etc.).
 *
 * Used by server-auto-review-manager.evaluate() to detect "agent committed
 * locally but did not cherry-pick onto baseRef" — the auto-review state
 * machine would otherwise never arm (changedFiles=0 looks idle) and the
 * card sits stuck in review forever even though there's work to ship.
 */
export async function countCommitsAheadOfBaseRef(worktreePath: string, baseRef: string): Promise<number | null> {
	const trimmed = baseRef.trim();
	if (!trimmed) {
		return null;
	}
	const result = await runGit(worktreePath, ["rev-list", "--count", `${trimmed}..HEAD`]);
	if (!result.ok) {
		return null;
	}
	const n = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(n) ? n : null;
}

interface GitPathFingerprint {
	path: string;
	size: number | null;
	mtimeMs: number | null;
	ctimeMs: number | null;
}

export interface GitWorkspaceProbe {
	repoRoot: string;
	headCommit: string | null;
	currentBranch: string | null;
	upstreamBranch: string | null;
	aheadCount: number;
	behindCount: number;
	changedFiles: number;
	untrackedPaths: string[];
	stateToken: string;
}

async function isSymlinkOutsideWorktree(worktreeRoot: string, relativePath: string): Promise<boolean> {
	try {
		const absPath = join(worktreeRoot, relativePath);
		const st = await lstat(absPath);
		if (!st.isSymbolicLink()) {
			return false;
		}
		const raw = await readlink(absPath);
		const target = isAbsolute(raw) ? raw : resolve(absPath, "..", raw);
		const rootResolved = resolve(worktreeRoot);
		// Symlink is "inside" the worktree iff its resolved target is at or
		// beneath the worktree root. Anything else (sibling worktrees, base
		// workspace, /tmp, ...) is outside.
		return !(target === rootResolved || target.startsWith(`${rootResolved}/`));
	} catch {
		return false;
	}
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	return text.split("\n").length;
}

function parseNumstatTotals(output: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const [addedRaw, deletedRaw] = line.split("\t");
		const added = Number.parseInt(addedRaw ?? "", 10);
		const deleted = Number.parseInt(deletedRaw ?? "", 10);
		if (Number.isFinite(added)) {
			additions += added;
		}
		if (Number.isFinite(deleted)) {
			deletions += deleted;
		}
	}

	return { additions, deletions };
}

function parseAheadBehindCounts(output: string): { aheadCount: number; behindCount: number } {
	const [aheadRaw, behindRaw] = output.trim().split(/\s+/, 2);
	const ahead = Math.abs(Number.parseInt(aheadRaw ?? "", 10));
	const behind = Math.abs(Number.parseInt(behindRaw ?? "", 10));
	return {
		aheadCount: Number.isFinite(ahead) ? ahead : 0,
		behindCount: Number.isFinite(behind) ? behind : 0,
	};
}

function buildFingerprintToken(fingerprints: GitPathFingerprint[]): string {
	return fingerprints
		.map((entry) => `${entry.path}\t${entry.size ?? "null"}\t${entry.mtimeMs ?? "null"}\t${entry.ctimeMs ?? "null"}`)
		.join("\n");
}

async function buildPathFingerprints(repoRoot: string, paths: string[]): Promise<GitPathFingerprint[]> {
	const uniqueSortedPaths = Array.from(new Set(paths)).sort((left, right) => left.localeCompare(right));
	return await Promise.all(
		uniqueSortedPaths.map(async (path) => {
			try {
				const fileStat = await stat(join(repoRoot, path));
				return {
					path,
					size: fileStat.size,
					mtimeMs: fileStat.mtimeMs,
					ctimeMs: fileStat.ctimeMs,
				} satisfies GitPathFingerprint;
			} catch {
				return {
					path,
					size: null,
					mtimeMs: null,
					ctimeMs: null,
				} satisfies GitPathFingerprint;
			}
		}),
	);
}

function parseStatusPath(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	const parts = trimmed.split("\t");
	const metadata = parts[0]?.trim() ?? "";
	const tokens = metadata.split(/\s+/);
	return tokens[tokens.length - 1] ?? null;
}

export async function probeGitWorkspaceState(cwd: string): Promise<GitWorkspaceProbe> {
	const repoRoot = await resolveRepoRoot(cwd);
	const [statusResult, headCommitResult] = await Promise.all([
		runGit(repoRoot, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
		runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]),
	]);

	if (!statusResult.ok) {
		throw new Error(statusResult.error ?? "Git status command failed.");
	}

	let currentBranch: string | null = null;
	let upstreamBranch: string | null = null;
	let aheadCount = 0;
	let behindCount = 0;
	const fingerprintPaths: string[] = [];
	const untrackedPaths: string[] = [];
	let changedFiles = 0;

	for (const rawLine of statusResult.stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			const branchName = line.slice("# branch.head ".length).trim();
			currentBranch = branchName && branchName !== "(detached)" ? branchName : null;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			upstreamBranch = line.slice("# branch.upstream ".length).trim() || null;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const counts = parseAheadBehindCounts(line.slice("# branch.ab ".length));
			aheadCount = counts.aheadCount;
			behindCount = counts.behindCount;
			continue;
		}
		if (line.startsWith("? ")) {
			const path = line.slice(2).trim();
			if (!path) {
				continue;
			}
			if (KANBAN_RUNTIME_SENTINELS.has(path)) {
				continue;
			}
			if (await isSymlinkOutsideWorktree(repoRoot, path)) {
				// Worktree setup occasionally leaves stale symlinks pointing
				// into the base workspace (e.g. __pycache__/ created before a
				// rename moved the parent dir). git refuses to evaluate
				// .gitignore "beyond a symbolic link", so these show up as
				// untracked forever and poison auto-review's changedFiles
				// count, leaving cards stuck after the commit lands.
				continue;
			}
			changedFiles += 1;
			untrackedPaths.push(path);
			fingerprintPaths.push(path);
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
			const path = parseStatusPath(line);
			if (!path) {
				continue;
			}
			if (KANBAN_RUNTIME_SENTINELS.has(path)) {
				continue;
			}
			changedFiles += 1;
			fingerprintPaths.push(path);
			const renameParts = line.split("\t");
			const previousPath = renameParts[1]?.trim();
			if (previousPath) {
				fingerprintPaths.push(previousPath);
			}
		}
	}

	const headCommit = headCommitResult.ok && headCommitResult.stdout ? headCommitResult.stdout : null;
	const fingerprints = await buildPathFingerprints(repoRoot, fingerprintPaths);

	return {
		repoRoot,
		headCommit,
		currentBranch,
		upstreamBranch,
		aheadCount,
		behindCount,
		changedFiles,
		untrackedPaths,
		stateToken: [
			repoRoot,
			headCommit ?? "no-head",
			currentBranch ?? "detached",
			upstreamBranch ?? "no-upstream",
			String(aheadCount),
			String(behindCount),
			statusResult.stdout,
			buildFingerprintToken(fingerprints),
		].join("\n--\n"),
	};
}

async function resolveRepoRoot(cwd: string): Promise<string> {
	const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (!result.ok || !result.stdout) {
		throw new Error("No git repository detected for this workspace.");
	}
	return result.stdout;
}

async function countUntrackedAdditions(repoRoot: string, untrackedPaths: string[]): Promise<number> {
	const counts = await Promise.all(
		untrackedPaths.map(async (relativePath) => {
			try {
				const contents = await readFile(join(repoRoot, relativePath), "utf8");
				return countLines(contents);
			} catch {
				return 0;
			}
		}),
	);
	return counts.reduce((total, value) => total + value, 0);
}

async function hasGitRef(repoRoot: string, ref: string): Promise<boolean> {
	const result = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
	return result.ok;
}

export async function getGitSyncSummary(
	cwd: string,
	options?: { probe?: GitWorkspaceProbe },
): Promise<RuntimeGitSyncSummary> {
	const probe = options?.probe ?? (await probeGitWorkspaceState(cwd));
	const diffResult = await runGit(probe.repoRoot, ["diff", "--numstat", "HEAD", "--"]);
	const trackedTotals = diffResult.ok ? parseNumstatTotals(diffResult.stdout) : { additions: 0, deletions: 0 };
	const untrackedAdditions = await countUntrackedAdditions(probe.repoRoot, probe.untrackedPaths);

	return {
		currentBranch: probe.currentBranch,
		upstreamBranch: probe.upstreamBranch,
		changedFiles: probe.changedFiles,
		additions: trackedTotals.additions + untrackedAdditions,
		deletions: trackedTotals.deletions,
		aheadCount: probe.aheadCount,
		behindCount: probe.behindCount,
	};
}

export async function runGitSyncAction(options: {
	cwd: string;
	action: RuntimeGitSyncAction;
}): Promise<RuntimeGitSyncResponse> {
	const initialSummary = await getGitSyncSummary(options.cwd);

	if (options.action === "pull" && initialSummary.changedFiles > 0) {
		return {
			ok: false,
			action: options.action,
			summary: initialSummary,
			output: "",
			error: "Pull failed: working tree has local changes. Commit, stash, or discard changes first.",
		};
	}

	const argsByAction: Record<RuntimeGitSyncAction, string[]> = {
		fetch: ["fetch", "--all", "--prune"],
		pull: ["pull", "--ff-only"],
		push: ["push"],
	};
	const commandResult = await runGit(options.cwd, argsByAction[options.action]);
	const nextSummary = await getGitSyncSummary(options.cwd);

	if (!commandResult.ok) {
		return {
			ok: false,
			action: options.action,
			summary: nextSummary,
			output: commandResult.output,
			error: commandResult.error ?? "Git command failed.",
		};
	}

	return {
		ok: true,
		action: options.action,
		summary: nextSummary,
		output: commandResult.output,
	};
}

export async function runGitCheckoutAction(options: {
	cwd: string;
	branch: string;
}): Promise<RuntimeGitCheckoutResponse> {
	const requestedBranch = options.branch.trim();
	const initialSummary = await getGitSyncSummary(options.cwd);

	if (!requestedBranch) {
		return {
			ok: false,
			branch: requestedBranch,
			summary: initialSummary,
			output: "",
			error: "Branch name cannot be empty.",
		};
	}

	if (initialSummary.currentBranch === requestedBranch) {
		return {
			ok: true,
			branch: requestedBranch,
			summary: initialSummary,
			output: `Already on '${requestedBranch}'.`,
		};
	}

	const repoRoot = await resolveRepoRoot(options.cwd);

	const hasLocalBranch = await hasGitRef(repoRoot, `refs/heads/${requestedBranch}`);
	const commandResult = hasLocalBranch
		? await runGit(repoRoot, ["switch", requestedBranch])
		: (await hasGitRef(repoRoot, `refs/remotes/origin/${requestedBranch}`))
			? await runGit(repoRoot, ["switch", "--track", `origin/${requestedBranch}`])
			: await runGit(repoRoot, ["switch", requestedBranch]);
	const nextSummary = await getGitSyncSummary(repoRoot);

	if (!commandResult.ok) {
		return {
			ok: false,
			branch: requestedBranch,
			summary: nextSummary,
			output: commandResult.output,
			error: commandResult.error ?? "Git branch switch failed.",
		};
	}

	return {
		ok: true,
		branch: requestedBranch,
		summary: nextSummary,
		output: commandResult.output,
	};
}

export async function discardGitChanges(options: { cwd: string }): Promise<RuntimeGitDiscardResponse> {
	const repoRoot = await resolveRepoRoot(options.cwd);
	const initialSummary = await getGitSyncSummary(repoRoot);

	if (initialSummary.changedFiles === 0) {
		return {
			ok: true,
			summary: initialSummary,
			output: "Working tree is already clean.",
		};
	}

	const restoreResult = await runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "."]);
	const cleanResult = restoreResult.ok ? await runGit(repoRoot, ["clean", "-fd", "--", "."]) : null;
	const nextSummary = await getGitSyncSummary(repoRoot);
	const output = [restoreResult.output, cleanResult?.output ?? ""].filter(Boolean).join("\n");

	if (!restoreResult.ok) {
		return {
			ok: false,
			summary: nextSummary,
			output,
			error: restoreResult.error ?? "Discard failed.",
		};
	}

	if (cleanResult && !cleanResult.ok) {
		return {
			ok: false,
			summary: nextSummary,
			output,
			error: cleanResult.error ?? "Discard failed while cleaning untracked files.",
		};
	}

	return {
		ok: true,
		summary: nextSummary,
		output,
	};
}
