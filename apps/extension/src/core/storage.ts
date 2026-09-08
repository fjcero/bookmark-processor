function hasRuntime(): boolean {
	try {
		return Boolean(chrome.runtime?.id);
	} catch {
		return false;
	}
}

export interface ExtensionSettings {
	serverUrl: string;
	mode: "api" | "download";
	autoSync: boolean;
	/** Opt-in capture on x.com/i/history. Default off. */
	captureHistory: boolean;
	/** Opt-in capture/sync on likes pages. Default off. */
	captureLikes: boolean;
	scrollDelayMs: number;
	/** Direct GraphQL article hydrations per service-worker alarm wake. */
	articleDirectBatch: number;
}

const SETTINGS_KEY = "bp-settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
	serverUrl: "http://localhost:3000",
	mode: "api",
	autoSync: true,
	captureHistory: false,
	captureLikes: false,
	scrollDelayMs: 300,
	articleDirectBatch: 5,
};

export function clampScrollDelayMs(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SETTINGS.scrollDelayMs;
	return Math.min(5000, Math.max(100, Math.round(value)));
}

export function clampArticleDirectBatch(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SETTINGS.articleDirectBatch;
	return Math.min(20, Math.max(1, Math.round(value)));
}

export async function loadSettings(): Promise<ExtensionSettings> {
	try {
		if (!hasRuntime()) return { ...DEFAULT_SETTINGS };
		const result = await chrome.storage.sync.get(SETTINGS_KEY);
		const saved = result[SETTINGS_KEY] as
			| Partial<ExtensionSettings>
			| undefined;
		return {
			...DEFAULT_SETTINGS,
			...saved,
			captureHistory: Boolean(saved?.captureHistory),
			captureLikes: Boolean(saved?.captureLikes),
			scrollDelayMs: clampScrollDelayMs(
				saved?.scrollDelayMs ?? DEFAULT_SETTINGS.scrollDelayMs,
			),
			articleDirectBatch: clampArticleDirectBatch(
				saved?.articleDirectBatch ?? DEFAULT_SETTINGS.articleDirectBatch,
			),
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
	try {
		if (!hasRuntime()) return;
		await chrome.storage.sync.set({
			[SETTINGS_KEY]: {
				...settings,
				captureHistory: Boolean(settings.captureHistory),
				captureLikes: Boolean(settings.captureLikes),
				scrollDelayMs: clampScrollDelayMs(settings.scrollDelayMs),
				articleDirectBatch: clampArticleDirectBatch(
					settings.articleDirectBatch,
				),
			},
		});
	} catch {
		/* ignore */
	}
}
