import {
	ARTICLE_GAP_MS,
	ARTICLE_POLL_IDLE_MS,
	ARTICLE_RATE_LIMIT_MS,
	ARTICLE_TAB_TIMEOUT_MS,
	articleQueueStats,
	enqueueArticles,
	isRateLimited,
	markArticleFailure,
	markArticleRateLimited,
	markArticleRemoved,
	markArticleSuccess,
	msUntilHydrationAllowed,
	nextQueueWakeAt,
	parseRetryAfterMs,
	articleUrl,
	findHydratedArticleResult,
	hasFullArticleBody,
	isArticleUnavailablePayload,
	isSafeArticleReplayUrl,
	isGraphqlWriteOperation,
	type ArticleQueueItem,
	type GraphQLArticleResult,
} from "@repo/import";
import {
	archiveUnavailableArticle,
	buildArticleHydrationPayload,
	fetchPendingArticles,
	uploadPayload,
} from "@repo/import/capture/engine";
import { scheduleSyncStatusPush } from "../../background/sync-server";
import { broadcastToTabs } from "../../core/broadcast";
import { idbDelete, idbGet } from "../../core/idb";
import { loadSettings } from "../../core/storage";
import {
	ALARM_NAME,
	claimNextArticle,
	loadArticleQueue,
	loadHydrationState,
	noteArticleCompleted,
	noteRateLimited,
	releaseArticleLease,
	updateHydrationState,
	updateArticleQueue,
} from "./article-queue";
import {
	requestForArticle,
	type ArticleRequestTemplate,
} from "./article-replay";
import {
	closeHydrationTab,
	ensureHydrationTab,
	findOpenedTab,
	loadOpenedTabs,
	saveOpenedTabs,
	type OpenedArticleTab,
} from "./article-tabs";
import {
	ARTICLE_LOCAL_QUEUE_CAP,
	ARTICLE_SERVER_PULL_EMPTY,
	ARTICLE_SERVER_PULL_TOPUP,
	ARTICLE_TEMPLATE_KEY,
	ARTICLE_TIMEOUT_PREFIX,
	X_TAB_URL_PATTERNS,
} from "./constants";

export async function recoverInterruptedArticles(): Promise<void> {
	const opened = await loadOpenedTabs();
	const active: OpenedArticleTab[] = [];
	for (const entry of opened) {
		try {
			await chrome.tabs.get(entry.tabId);
			active.push(entry);
		} catch {
			/* tab already gone */
		}
	}
	await saveOpenedTabs(active);
	const activeIds = new Set(active.map((entry) => entry.articleId));
	await updateHydrationState((state) => {
		for (const item of state.queue) {
			if (item.status !== "fetching" || activeIds.has(item.articleId)) continue;
			item.status = "pending";
			item.nextAt = undefined;
			item.lastError = "Background worker restarted";
		}
		if (
			state.processingArticleId &&
			!activeIds.has(state.processingArticleId)
		) {
			state.processingArticleId = undefined;
			state.leaseUntil = undefined;
		}
		return state;
	});
}

export async function scheduleNext(delayMs = ARTICLE_GAP_MS): Promise<void> {
	const state = await loadHydrationState();
	const now = Date.now();
	const wait = Math.max(delayMs, msUntilHydrationAllowed(state, now));
	const wake = nextQueueWakeAt(state.queue, state, now);
	// MV3 alarms floor at ~30s; that is the effective article gap.
	const when = now + Math.max(30_000, wait, wake ?? 0);
	try {
		await chrome.alarms.create(ALARM_NAME, { when });
	} catch {
		/* ignore */
	}
}

export async function broadcastStats(): Promise<void> {
	const queue = await loadArticleQueue();
	const stats = articleQueueStats(queue);
	await broadcastToTabs(X_TAB_URL_PATTERNS, {
		type: "bp-article-stats",
		stats,
	});
	scheduleSyncStatusPush();
}

export async function ingestPendingFromServer(): Promise<void> {
	const state = await loadHydrationState();
	if (isRateLimited(state)) return;
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return;
	const queue = await loadArticleQueue();
	const pendingCount = queue.filter(
		(item) => item.status === "pending" || item.status === "fetching",
	).length;
	if (pendingCount >= ARTICLE_LOCAL_QUEUE_CAP) return;
	try {
		const limit =
			pendingCount === 0
				? ARTICLE_SERVER_PULL_EMPTY
				: ARTICLE_SERVER_PULL_TOPUP;
		const pending = await fetchPendingArticles(settings.serverUrl, limit);
		if (pending.length === 0) return;
		await updateArticleQueue((queue) => enqueueArticles(queue, pending));
		await broadcastStats();
	} catch {
		/* server offline */
	}
}

export async function handleArticleUnavailable(
	articleId: string,
	tabId?: number,
	opts: { deferSchedule?: boolean } = {},
): Promise<boolean> {
	const openedTabs = await loadOpenedTabs();
	const opened =
		tabId != null
			? openedTabs.find((entry) => entry.tabId === tabId)
			: openedTabs.find((entry) => entry.articleId === articleId);
	const queue = await loadArticleQueue();
	const queued = queue.find(
		(item) => item.articleId === articleId && item.status !== "ok",
	);
	if (!opened && !queued) return false;

	const tweetId = opened?.tweetId ?? queued?.tweetId;
	if (!tweetId) return false;

	const settings = await loadSettings();
	if (settings.mode === "api" && settings.serverUrl) {
		try {
			await archiveUnavailableArticle(settings.serverUrl, tweetId);
		} catch {
			/* server offline */
		}
	}

	if (tabId != null) {
		await closeHydrationTab(tabId);
	} else if (opened) {
		await closeHydrationTab(opened.tabId);
	}

	await updateArticleQueue((items) => markArticleRemoved(items, articleId));
	await releaseArticleLease(articleId);
	if (!opts.deferSchedule) {
		await broadcastStats();
		await scheduleNext();
	}
	return true;
}

async function hydrateArticleDirect(
	next: ArticleQueueItem,
	opts: { deferSchedule?: boolean } = {},
): Promise<"ok" | "unavailable" | "retry" | "tab"> {
	const template = await idbGet<ArticleRequestTemplate>(ARTICLE_TEMPLATE_KEY);
	if (!template) return "tab";
	if (
		!isSafeArticleReplayUrl(template.url) ||
		isGraphqlWriteOperation(template.url)
	) {
		await idbDelete(ARTICLE_TEMPLATE_KEY);
		return "tab";
	}
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return "tab";

	try {
		const replay = requestForArticle(template, next.articleId);
		const response = await fetch(replay.url, {
			method: template.method,
			headers: template.headers,
			body: template.method === "GET" ? undefined : replay.body,
			credentials: "include",
		});
		if (response.status === 429) {
			const delay = parseRetryAfterMs(
				response.headers.get("retry-after"),
				ARTICLE_RATE_LIMIT_MS,
			);
			await noteRateLimited(delay);
			const limited = await loadHydrationState();
			await updateArticleQueue((items) =>
				markArticleRateLimited(
					items,
					next.articleId,
					"X rate limited article request (429)",
					Date.now(),
					limited.rateLimitHits ?? 1,
				),
			);
			await releaseArticleLease(next.articleId);
			await broadcastStats();
			await scheduleNext(delay);
			return "retry";
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				await idbDelete(ARTICLE_TEMPLATE_KEY);
			}
			return "tab";
		}
		const data = await response.json();
		if (isArticleUnavailablePayload(data)) {
			await handleArticleUnavailable(next.articleId, undefined, opts);
			return "unavailable";
		}
		const article = findHydratedArticleResult(data);
		await uploadPayload(
			buildArticleHydrationPayload(
				next.tweetId,
				article ?? { rest_id: next.articleId },
				"bookmark",
				next.url,
				data,
			),
			settings.serverUrl,
		);
		if (!article || !hasFullArticleBody(article)) {
			return "tab";
		}
		await updateArticleQueue((items) =>
			markArticleSuccess(items, next.articleId),
		);
		await noteArticleCompleted();
		await releaseArticleLease(next.articleId);
		if (!opts.deferSchedule) {
			await broadcastStats();
			await scheduleNext();
		}
		return "ok";
	} catch {
		return "tab";
	}
}

async function scheduleWhenArticleQueueIdle(): Promise<void> {
	const refreshed = await loadHydrationState();
	if (refreshed.queue.some((item) => item.status === "fetching")) {
		await scheduleNext(5_000);
		return;
	}
	const wake = nextQueueWakeAt(refreshed.queue, refreshed);
	if (wake != null) {
		await scheduleNext(wake);
		return;
	}
	if (refreshed.queue.some((item) => item.status === "failed")) {
		await scheduleNext(ARTICLE_POLL_IDLE_MS);
		return;
	}
	await scheduleNext(ARTICLE_POLL_IDLE_MS);
}

async function openArticleTab(next: ArticleQueueItem): Promise<void> {
	const tabId = await ensureHydrationTab(next.url);
	if (tabId == null) {
		await updateArticleQueue((items) =>
			markArticleFailure(items, next.articleId, "Failed to open tab"),
		);
		await releaseArticleLease(next.articleId);
		await scheduleNext();
		return;
	}
	await saveOpenedTabs([
		{
			tabId,
			articleId: next.articleId,
			tweetId: next.tweetId,
			url: next.url,
		},
	]);
	await chrome.alarms.create(`${ARTICLE_TIMEOUT_PREFIX}${tabId}`, {
		when: Date.now() + ARTICLE_TAB_TIMEOUT_MS,
	});
}

export async function hydrateNext(): Promise<void> {
	if ((await loadOpenedTabs()).length > 0) return;
	let state = await loadHydrationState();
	if (isRateLimited(state)) {
		await scheduleNext(msUntilHydrationAllowed(state));
		return;
	}

	let directDone = 0;
	const settings = await loadSettings();
	const directBatch = settings.articleDirectBatch;
	while (directDone < directBatch) {
		if ((await loadOpenedTabs()).length > 0) return;
		state = await loadHydrationState();
		if (isRateLimited(state)) {
			await scheduleNext(msUntilHydrationAllowed(state));
			return;
		}

		let next = await claimNextArticle();
		if (!next) {
			await ingestPendingFromServer();
			next = await claimNextArticle();
		}
		if (!next) {
			if (directDone > 0) {
				await broadcastStats();
				await scheduleNext();
			} else {
				await scheduleWhenArticleQueueIdle();
			}
			return;
		}

		const deferSchedule = directDone < directBatch - 1;
		const direct = await hydrateArticleDirect(next, { deferSchedule });
		if (direct === "retry") return;
		if (direct === "tab") {
			await broadcastStats();
			try {
				await openArticleTab(next);
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "Failed to open article tab";
				await updateArticleQueue((items) =>
					markArticleFailure(items, next.articleId, msg),
				);
				await releaseArticleLease(next.articleId);
				await scheduleNext();
			}
			return;
		}

		directDone += 1;
	}

	await broadcastStats();
	await scheduleNext();
}

export async function failTab(tabId: number, error: string): Promise<void> {
	const opened = await findOpenedTab(tabId);
	if (!opened) return;
	await closeHydrationTab(tabId);
	await updateArticleQueue((items) =>
		markArticleFailure(items, opened.articleId, error),
	);
	await releaseArticleLease(opened.articleId);
	await broadcastStats();
	await scheduleNext();
}

export async function captureArticleBody(
	article: GraphQLArticleResult,
	senderTabId?: number,
	raw?: unknown,
): Promise<void> {
	if (!hasFullArticleBody(article)) return;
	const articleId = article.rest_id ?? null;
	if (!articleId) return;

	const openedTabs = await loadOpenedTabs();
	let opened =
		senderTabId != null
			? openedTabs.find((entry) => entry.tabId === senderTabId)
			: undefined;
	if (opened && opened.articleId !== articleId) {
		opened = undefined;
	}
	if (!opened) {
		opened = openedTabs.find((entry) => entry.articleId === articleId);
		if (opened) senderTabId = opened.tabId;
	}

	const queue = await loadArticleQueue();
	const queued = queue.find((item) => item.articleId === articleId);
	const tweetId = opened?.tweetId ?? queued?.tweetId;
	const tabId = opened?.tabId ?? senderTabId;
	if (!tweetId) return;

	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) {
		if (tabId != null) await failTab(tabId, "Server URL not set");
		return;
	}

	try {
		const payload = buildArticleHydrationPayload(
			tweetId,
			article,
			"bookmark",
			opened?.url ?? queued?.url ?? articleUrl(articleId),
			raw,
		);
		await uploadPayload(payload, settings.serverUrl);
		await updateArticleQueue((items) => markArticleSuccess(items, articleId));
		await noteArticleCompleted();
		await releaseArticleLease(articleId);
		if (tabId != null) await closeHydrationTab(tabId);
		await broadcastStats();
		await scheduleNext();
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Upload failed";
		if (tabId != null) await failTab(tabId, msg);
	}
}

export async function bootstrapArticles(): Promise<void> {
	await recoverInterruptedArticles();
	await ingestPendingFromServer();
	await scheduleNext(5_000);
}
