// Tiny logging shim for server-side modules.
//
// kanban does not yet have a project-wide logger abstraction (see
// `grit/no-console.grit` which forbids direct console calls outside
// `src/cli.ts`). The cline-runtime-logger is too cline-specific for general
// server use. This shim centralises the ignored console calls so callers stay
// clean.
//
// If a real logging abstraction lands upstream, redirect this module to it.

export const logInfo = (msg: string, meta?: unknown): void => {
	if (meta === undefined) {
		console.log(msg);
		return;
	}
	console.log(msg, meta);
};

export const logWarn = (msg: string, meta?: unknown): void => {
	if (meta === undefined) {
		console.warn(msg);
		return;
	}
	console.warn(msg, meta);
};

export const logError = (msg: string, err?: unknown): void => {
	if (err === undefined) {
		console.error(msg);
		return;
	}
	console.error(msg, err);
};
