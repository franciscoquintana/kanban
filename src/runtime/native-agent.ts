// Shared between server and web-ui: detection of the native Cline agent.
// The server uses this to decide whether to dispatch task-session input via the
// Cline chat service or via the terminal manager. The web-ui re-exports it.

import type { RuntimeAgentId } from "../core/api-contract.js";

export function isNativeClineAgentSelected(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId === "cline";
}
