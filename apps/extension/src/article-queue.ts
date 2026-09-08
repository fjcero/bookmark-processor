import {
	enqueueArticles,
	extendRateLimit,
	type ArticleHydrationState,
	type ArticleQueueItem,
} from "@repo/import";
import { idbDelete, idbGet, idbSet } from "./idb";

const HYDRATION_KEY = "bp-article-hydration";
const LEGACY_QUEUE_KEY = "bp-article-queue";
export const ALARM_NAME = "bp-article-hydrate";

const EMPTY_STATE: ArticleHydrationState = { queue: [] };

async function migrateLegacyQueue(): Promise<ArticleHydrationState | null> {
	try {
		const result = await chrome.storage.local.get(LEGACY_QUEUE_KEY);
		const queue = result[LEGACY_QUEUE_KEY] as ArticleQueueItem[] | undefined;
		if (!Array.isArray(queue) || queue.length === 0) return null;
		await chrome.storage.local.remove(LEGACY_QUEUE_KEY);
		return { queue };
	} catch {
		return null;
	}
}

export async function loadHydrationState(): Promise<ArticleHydrationState> {
	const saved = await idbGet<ArticleHydrationState>(HYDRATION_KEY);
	if (saved && Array.isArray(saved.queue)) return saved;
	const legacy = await migrateLegacyQueue();
	if (legacy) {
		await idbSet(HYDRATION_KEY, legacy);
		return legacy;
	}
	return EMPTY_STATE;
}

export async function saveHydrationState(
	state: ArticleHydrationState,
): Promise<void> {
	await idbSet(HYDRATION_KEY, state);
}

export async function loadArticleQueue(): Promise<ArticleQueueItem[]> {
	return (await loadHydrationState()).queue;
}

export async function updateHydrationState(
	mutator: (state: ArticleHydrationState) => ArticleHydrationState,
): Promise<ArticleHydrationState> {
	const current = await loadHydrationState();
	const next = mutator(current);
	await saveHydrationState(next);
	return next;
}

export async function updateArticleQueue(
	mutator: (queue: ArticleQueueItem[]) => ArticleQueueItem[],
): Promise<ArticleQueueItem[]> {
	const state = await updateHydrationState((current) => ({
		...current,
		queue: mutator(current.queue),
	}));
	return state.queue;
}

export async function noteArticleCompleted(): Promise<void> {
	await updateHydrationState((state) => ({
		...state,
		lastCompletedAt: Date.now(),
	}));
}

export async function noteRateLimited(delayMs: number): Promise<number> {
	const state = await updateHydrationState((current) =>
		extendRateLimit(current, delayMs),
	);
	return state.rateLimitedUntil ?? Date.now() + delayMs;
}

export { enqueueArticles };
