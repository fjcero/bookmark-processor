import {
	enqueueArticles,
	extendRateLimit,
	markArticleFetching,
	pickNextArticle,
	type ArticleHydrationState,
	type ArticleQueueItem,
} from "@repo/import";
import { idbGet, idbSet, idbUpdate } from "../../core/idb";

const HYDRATION_KEY = "bp-article-hydration";
const LEGACY_QUEUE_KEY = "bp-article-queue";
export const ALARM_NAME = "bp-article-hydrate";
const ARTICLE_LEASE_MS = 120_000;

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
	const initial = await loadHydrationState();
	return idbUpdate<ArticleHydrationState>(HYDRATION_KEY, (saved) =>
		mutator(saved ?? initial),
	);
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

export async function compactArticleQueue(): Promise<void> {
	await updateArticleQueue((queue) => {
		const seen = new Set<string>();
		const next: ArticleQueueItem[] = [];
		for (const item of queue) {
			if (item.status === "ok") continue;
			if (seen.has(item.articleId)) continue;
			seen.add(item.articleId);
			next.push(item);
		}
		return next;
	});
}

export async function noteArticleCompleted(): Promise<void> {
	await updateHydrationState((state) => ({
		...state,
		lastCompletedAt: Date.now(),
		rateLimitedUntil: undefined,
		rateLimitHits: 0,
	}));
}

export async function noteRateLimited(delayMs: number): Promise<number> {
	const state = await updateHydrationState((current) =>
		extendRateLimit(current, delayMs),
	);
	return state.rateLimitedUntil ?? Date.now() + delayMs;
}

/** Atomically claim one article for one worker event. */
export async function claimNextArticle(
	now = Date.now(),
): Promise<ArticleQueueItem | null> {
	await loadHydrationState();
	let claimed: ArticleQueueItem | null = null;
	await idbUpdate<ArticleHydrationState>(HYDRATION_KEY, (saved) => {
		const state = saved ?? { queue: [] };
		if ((state.leaseUntil ?? 0) > now) return state;

		if (state.processingArticleId) {
			const interrupted = state.queue.find(
				(item) => item.articleId === state.processingArticleId,
			);
			if (interrupted?.status === "fetching") {
				interrupted.status = "pending";
				interrupted.nextAt = undefined;
				interrupted.lastError = "Article worker lease expired";
			}
		}

		const next = pickNextArticle(state.queue, now);
		if (!next) {
			return {
				...state,
				processingArticleId: undefined,
				leaseUntil: undefined,
			};
		}
		markArticleFetching(state.queue, next.articleId);
		state.processingArticleId = next.articleId;
		state.leaseUntil = now + ARTICLE_LEASE_MS;
		claimed = { ...next };
		return state;
	});
	return claimed;
}

export async function releaseArticleLease(articleId: string): Promise<void> {
	await updateHydrationState((state) => {
		if (state.processingArticleId !== articleId) return state;
		return {
			...state,
			processingArticleId: undefined,
			leaseUntil: undefined,
		};
	});
}

export { enqueueArticles };
