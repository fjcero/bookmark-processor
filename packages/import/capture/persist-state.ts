export interface SlimCaptureState {
	tweets?: Record<string, unknown>;
	seen?: string[];
	synced?: string[];
	responses?: unknown[];
}

/** Persist only in-flight tweet payloads. ID lists live in the library cache. */
export function toPersistedCaptureState<T extends SlimCaptureState>(state: T): T {
	const tweets = state.tweets ?? {};
	return {
		...state,
		tweets,
		seen: Object.keys(tweets),
		synced: [],
	};
}
