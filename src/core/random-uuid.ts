// Cross-environment UUID v4 generator.
//
// `crypto.randomUUID` is only available in:
//  - Node 16.7+ (always)
//  - Browsers running in a secure context (HTTPS, file://, or localhost).
//
// When kanban is exposed over plain HTTP from a remote machine (e.g. SSH
// tunnel host or LAN IP), the browser treats the page as insecure and
// `crypto.randomUUID` is `undefined`. Calls into shared code like
// `task-board-mutations.ts` then crash with `TypeError: crypto.randomUUID is
// not a function`.
//
// This helper falls back to a minimal v4 generator built on `crypto.getRandomValues`
// (available in every browser regardless of context) and finally on
// `Math.random` if even that is missing.
interface CryptoLike {
	randomUUID?: () => string;
	getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

export function randomUuid(): string {
	const cryptoObj = (globalThis as { crypto?: CryptoLike }).crypto;
	if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
		return cryptoObj.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
		cryptoObj.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	// RFC 4122 v4 layout: set version (4) and variant (10xx) bits.
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
