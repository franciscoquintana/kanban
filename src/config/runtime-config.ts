// Persists Kanban-owned runtime preferences on disk.
// This module should store Kanban settings such as selected agents,
// shortcuts, and prompt templates, not SDK-owned Cline secrets or OAuth data.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { detectInstalledCommands } from "../terminal/agent-registry";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils";

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PARENT_DIR = ".cline";
const PROJECT_CONFIG_DIR = "kanban";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "cline";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex", "droid", "kiro"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = true;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

# Pre-commit review pipeline

Before staging or cherry-picking, run a multi-agent quality review on the diff in this worktree.

Launch the four reviewers below IN PARALLEL using the Agent tool — send a single message with multiple Agent tool calls so they run concurrently. Each reviewer must return a report in this exact format:

  STATUS: PASS | WARN | CRITICAL
  CRITICAL: <bullet list of must-fix items, file:line where possible>
  WARN: <bullet list of nice-to-fix items>
  NOTES: <one short paragraph summary>

Reviewers (run in parallel):

1. Agent(security-reviewer): If the \`/security-review\` skill is available in this environment, use it. Otherwise scan the diff manually. Look for: hard-coded secrets/credentials, SQL injection, command injection, path traversal, missing authn/authz on new endpoints, unsafe deserialization, weak crypto, sensitive data in logs, SSRF, XSS in rendered output. Start with \`git diff --name-only HEAD\` to scope the review. Keep the report under 200 words.

2. Agent(test-reviewer): For each non-trivial file in the diff, check whether there is a corresponding test file (sibling \`*.test.*\`/\`*.spec.*\`, or under \`tests/\` / \`__tests__/\` / \`test/\` for the module). Look for: business logic added without any test (CRITICAL), missing edge-case coverage (WARN), tests that mock the system-under-test instead of testing it (WARN), assertions that don't actually check the right thing. Keep the report under 200 words.

3. Agent(architecture-reviewer): Read the project root \`AGENTS.md\`, \`CLAUDE.md\`, and any \`docs/architecture.md\` or \`docs/hexagonal.md\` if they exist (use Read tool, not Bash cat). Then check that the diff respects: documented layering, naming conventions, file placement (e.g. is a domain entity sneaking infrastructure imports?), DRY principles called out there. Mark CRITICAL only for clear violations of stated rules; speculative concerns go to WARN. Keep the report under 200 words.

4. Agent(simplify-reviewer): If the \`/simplify\` skill is available, use it. Otherwise scan the diff for: error handling for impossible cases, premature abstractions for hypothetical needs, comments that explain WHAT instead of WHY, dead backwards-compatibility shims, redundant input validation at internal boundaries, half-finished implementations, three-line abstractions used in a single call site. Keep the report under 200 words.

Aggregate the four reports. Decision rule:
- ANY reviewer returns CRITICAL → fix the cited issues with targeted edits, then re-launch only the reviewer(s) that flagged. Repeat until no CRITICAL remains.
- WARN-only → record them in the final commit report but proceed.
- All PASS → proceed.

Hard cap: at most 3 review-and-fix iterations. If CRITICAL still remains after 3 rounds, stop iterating, write a clear note describing what is unresolved, and proceed to the commit step anyway — the alternative (leaving the task armed indefinitely) is worse for the human reviewing the board.

# Commit / cherry-pick

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P. If this fails because .git/index.lock exists, wait briefly for any active git process to finish. If the lock remains and no git process is active, treat the lock as stale, remove it, and retry.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If step 4 created a new stash entry, restore that stash with: git -C P stash pop <stash-ref>
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Reviewer summary: counts of PASS / WARN / CRITICAL and any remaining WARN items
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

# Pre-PR review pipeline

Before pushing or opening the PR, run a multi-agent quality review on the diff in this worktree.

Launch the four reviewers below IN PARALLEL using the Agent tool — single message, multiple Agent tool calls. Each reviewer returns:

  STATUS: PASS | WARN | CRITICAL
  CRITICAL: <bullet list, file:line where possible>
  WARN: <bullet list>
  NOTES: <one short paragraph>

Reviewers:

1. Agent(security-reviewer): Use \`/security-review\` if available, else scan the diff for: hard-coded secrets, SQL/command/path injection, missing authn/authz on new endpoints, unsafe deserialization, weak crypto, sensitive logs, SSRF, XSS. <200 words.

2. Agent(test-reviewer): For each non-trivial file in the diff, verify there's a sibling or sibling-folder test file. Flag CRITICAL when business logic is added without any test, WARN for missing edge-case coverage. <200 words.

3. Agent(architecture-reviewer): Read \`AGENTS.md\`, \`CLAUDE.md\`, \`docs/architecture.md\`, \`docs/hexagonal.md\` if present. Check the diff respects documented layering, naming, file placement, DRY. CRITICAL only for clear documented-rule violations. <200 words.

4. Agent(simplify-reviewer): Use \`/simplify\` if available, else flag: error handling for impossible cases, premature abstractions, comments explaining WHAT not WHY, dead backwards-compat shims, redundant validation. <200 words.

Aggregation rule:
- Any CRITICAL → fix and re-launch only the affected reviewer. Repeat. Hard cap: 3 iterations.
- WARN-only → keep them; mention in the PR body.
- All PASS → proceed.

If CRITICAL remains after 3 rounds, proceed anyway and call it out in the PR body so the human reviewer sees the gap.

# Open PR

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. The PR body must include:
   - A short Summary of the change
   - Reviewer summary: PASS/WARN/CRITICAL counts, plus the bullet list of any remaining WARN/CRITICAL items
   - Test plan
7. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
8. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Reviewer summary
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
		const binary = catalogEntry?.binary ?? agentId;
		if (detected.has(binary) || detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if (
		(agentId === "claude" ||
			agentId === "codex" ||
			agentId === "gemini" ||
			agentId === "opencode" ||
			agentId === "droid" ||
			agentId === "kiro" ||
			agentId === "cline") &&
		isRuntimeAgentLaunchSupported(agentId)
	) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	return requests;
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const agentAutonomousModeEnabled =
		config.agentAutonomousModeEnabled === undefined
			? DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
			: normalizeBoolean(config.agentAutonomousModeEnabled, DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);

	const payload: RuntimeGlobalConfigFileShape = {};
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentAutonomousModeEnabled !== DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
	) {
		payload.agentAutonomousModeEnabled = agentAutonomousModeEnabled;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState(configFiles);
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			input.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(input.shortcuts),
		commitPromptTemplate: normalizePromptTemplate(input.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(input.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		shortcuts: [],
		commitPromptTemplate: current.commitPromptTemplate,
		openPrPromptTemplate: current.openPrPromptTemplate,
	});
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd),
		async () => await loadRuntimeConfigLocked(cwd),
	);
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(null);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(null),
		async () => await loadRuntimeConfigLocked(null),
	);
}

export async function saveRuntimeConfig(
	cwd: string,
	config: {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		agentAutonomousModeEnabled: boolean;
		readyForReviewNotificationsEnabled: boolean;
		shortcuts: RuntimeProjectShortcut[];
		commitPromptTemplate: string;
		openPrPromptTemplate: string;
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			shortcuts: config.shortcuts,
			commitPromptTemplate: config.commitPromptTemplate,
			openPrPromptTemplate: config.openPrPromptTemplate,
		});
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		const nextConfig = {
			selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
			selectedShortcutLabel:
				updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
			agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled:
				updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
			shortcuts: projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts,
			commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
			openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
		};

		const hasChanges =
			nextConfig.selectedAgentId !== current.selectedAgentId ||
			nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
			nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
			nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
			nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
			nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
			!areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts);

		if (!hasChanges) {
			return current;
		}

		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextConfig.shortcuts,
		});
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			shortcuts: nextConfig.shortcuts,
			commitPromptTemplate: nextConfig.commitPromptTemplate,
			openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		});
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(
		[
			{
				path: globalConfigPath,
				type: "file",
			},
		],
		async () => {
			const nextConfig = {
				selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
				selectedShortcutLabel:
					updates.selectedShortcutLabel === undefined
						? current.selectedShortcutLabel
						: updates.selectedShortcutLabel,
				agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled:
					updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
				shortcuts: current.shortcuts,
				commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
				openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
			};

			const hasChanges =
				nextConfig.selectedAgentId !== current.selectedAgentId ||
				nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
				nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
				nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
				nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
				nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate;

			if (!hasChanges) {
				return current;
			}

			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			});

			return createRuntimeConfigStateFromValues({
				globalConfigPath,
				projectConfigPath: current.projectConfigPath,
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				shortcuts: nextConfig.shortcuts,
				commitPromptTemplate: nextConfig.commitPromptTemplate,
				openPrPromptTemplate: nextConfig.openPrPromptTemplate,
			});
		},
	);
}
