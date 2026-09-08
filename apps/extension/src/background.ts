import {
	ARTICLE_GAP_MS,
	ARTICLE_POLL_IDLE_MS,
	ARTICLE_RATE_LIMIT_MS,
	ARTICLE_TAB_TIMEOUT_MS,
	articleQueueStats,
	enqueueArticles,
	isRateLimited,
	markArticleFailure,
	markArticleFetching,
	markArticleRateLimited,
	markArticleRemoved,
	markArticleSuccess,
	msUntilHydrationAllowed,
	nextQueueWakeAt,
	parseRetryAfterMs,
	pendingArticleFromRaw,
	pickNextArticle,
	retryFailedArticles,
	articleUrl,
	findHydratedArticleResult,
	hasFullArticleBody,
	isArticleUnavailablePayload,
	type ArticleQueueItem,
	type GraphQLArticleResult,
} from "@repo/import";
import {
	archiveUnavailableArticle,
	buildArticleHydrationPayload,
	fetchPendingArticles,
	fetchServerTotal,
	uploadPayload,
	type CaptureState,
	type ExportPayload,
} from "@repo/import/capture/engine";
import type { CaptureEventDetail } from "@repo/import/capture/hooks-events";
import {
	ALARM_NAME,
	loadArticleQueue,
	loadHydrationState,
	noteArticleCompleted,
	noteRateLimited,
	updateArticleQueue,
} from "./article-queue";
import { idbDelete, idbGet, idbSet } from "./idb";
import {
	createArticleRequestTemplate,
	requestForArticle,
	type ArticleRequestTemplate,
} from "./article-replay";
import { loadSettings } from "./storage";
import {
	collectTimelineTweets,
	createTimelineJob,
	findBottomCursor,
	requestForCursor,
	type TimelineJob,
} from "./timeline-pagination";

const CAPTURE_KEY = "capture";
const PENDING_UPLOAD_KEY = "pending-upload";
const SYNC_RETRY_ALARM = "bp-sync-retry";
const LEGACY_STORAGE_KEY = "x-export-v2-state";
const ARTICLE_TABS_KEY = "article-tabs";
const ARTICLE_WORKER_TAB_KEY = "article-worker-tab";
const ARTICLE_TEMPLATE_KEY = "article-request-template";
const ARTICLE_TIMEOUT_PREFIX = "bp-article-timeout:";
const TIMELINE_JOB_KEY = "timeline-job";
const TIMELINE_ALARM = "bp-timeline-page";
const TIMELINE_PAGES_PER_RUN = 8;
const TIMELINE_UPLOAD_BATCH = 20;

interface OpenedArticleTab {
	tabId: number;
	articleId: string;
	tweetId: string;
	url: string;
}

const CAPTURE_BUSY_RETRY_MS = 60_000;
const ARTICLE_TAB_LOAD_MS = 30_000;

let bootstrapped = false;
let hydrating = false;
let timelineRunning = false;
let tabEnsureInFlight: Promise<number | null> | null = null;
let hydrationChain: Promise<void> = Promise.resolve();
/** Bookmarks tab is auto-scrolling; avoid opening article tabs in the same window. */
let captureScrollActive = false;

async function bootstrapArticles(): Promise<void> {
	if (bootstrapped) return;
	bootstrapped = true;
	await recoverInterruptedArticles();
	await ingestPendingFromServer();
	await scheduleNext(5_000);
}

function queueHydration(): void {
	hydrationChain = hydrationChain
		.then(() => hydrateNext())
		.catch(() => {
			/* next tick */
		});
}

chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.remove(LEGACY_STORAGE_KEY).catch(() => {
		/* ignore */
	});
	void bootstrapArticles();
});

async function removeSyncedFromCapture(payload: ExportPayload): Promise<void> {
	const state = await idbGet<CaptureState>(CAPTURE_KEY);
	if (!state?.tweets) return;
	for (const id of Object.keys(payload.tweets)) {
		delete state.tweets[id];
	}
	await idbSet(CAPTURE_KEY, state);
}

async function syncPayload(input: {
	payload: ExportPayload;
	serverUrl: string;
}): Promise<{ imported: number; skipped: number; total: number | null }> {
	await idbSet(PENDING_UPLOAD_KEY, input);
	try {
		const result = await uploadPayload(input.payload, input.serverUrl);
		await removeSyncedFromCapture(input.payload);
		await idbDelete(PENDING_UPLOAD_KEY);
		await chrome.alarms.clear(SYNC_RETRY_ALARM);
		return result;
	} catch (err) {
		await chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: 1 });
		throw err;
	}
}

async function retryPendingUpload(): Promise<void> {
	const pending = await idbGet<{ payload: ExportPayload; serverUrl: string }>(
		PENDING_UPLOAD_KEY,
	);
	if (!pending) return;
	try {
		await uploadPayload(pending.payload, pending.serverUrl);
		await removeSyncedFromCapture(pending.payload);
		await idbDelete(PENDING_UPLOAD_KEY);
	} catch {
		await chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: 1 });
	}
}

async function loadOpenedTabs(): Promise<OpenedArticleTab[]> {
	return (await idbGet<OpenedArticleTab[]>(ARTICLE_TABS_KEY)) ?? [];
}

async function saveOpenedTabs(tabs: OpenedArticleTab[]): Promise<void> {
	await idbSet(ARTICLE_TABS_KEY, tabs);
}

async function findOpenedTab(tabId: number): Promise<OpenedArticleTab | undefined> {
	return (await loadOpenedTabs()).find((entry) => entry.tabId === tabId);
}

async function removeOpenedTab(tabId: number): Promise<OpenedArticleTab | undefined> {
	const tabs = await loadOpenedTabs();
	const opened = tabs.find((entry) => entry.tabId === tabId);
	if (opened) {
		await saveOpenedTabs(tabs.filter((entry) => entry.tabId !== tabId));
	}
	return opened;
}

async function waitForTabLoad(
	tabId: number,
	timeoutMs: number,
	expectUrl?: string,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			chrome.tabs.onUpdated.removeListener(listener);
			if (error) reject(error);
			else resolve();
		};
		const matches = (tabUrl?: string) =>
			!expectUrl || (tabUrl != null && tabUrl.startsWith(expectUrl));
		const timeout = setTimeout(() => {
			finish(new Error("Article tab load timeout"));
		}, timeoutMs);
		const listener = (
			updatedTabId: number,
			info: chrome.tabs.TabChangeInfo,
			tab: chrome.tabs.Tab,
		) => {
			if (updatedTabId !== tabId || info.status !== "complete") return;
			if (matches(tab.url)) finish();
		};
		chrome.tabs.onUpdated.addListener(listener);
		void chrome.tabs.get(tabId).then((existing) => {
			if (existing.status === "complete" && matches(existing.url)) finish();
		}, () => {
			finish(new Error("Article tab closed"));
		});
	});
}

async function loadWorkerTabId(): Promise<number | null> {
	return (await idbGet<number>(ARTICLE_WORKER_TAB_KEY)) ?? null;
}

async function saveWorkerTabId(tabId: number | null): Promise<void> {
	if (tabId == null) {
		await idbDelete(ARTICLE_WORKER_TAB_KEY);
		return;
	}
	await idbSet(ARTICLE_WORKER_TAB_KEY, tabId);
}

/** Open or reuse one background worker tab without stealing focus. */
async function ensureHydrationTab(url: string): Promise<number | null> {
	if (tabEnsureInFlight) return tabEnsureInFlight;
	tabEnsureInFlight = (async () => {
		try {
			const opened = await loadOpenedTabs();
			if (opened.length > 0) {
				const entry = opened[0]!;
				try {
					await chrome.tabs.get(entry.tabId);
					await chrome.tabs.update(entry.tabId, { url, active: false });
					await keepWorkerTabWarm(entry.tabId);
					await saveWorkerTabId(entry.tabId);
					return entry.tabId;
				} catch {
					await saveOpenedTabs([]);
					await saveWorkerTabId(null);
				}
			}

			const savedId = await loadWorkerTabId();
			if (savedId != null) {
				try {
					await chrome.tabs.get(savedId);
					await chrome.tabs.update(savedId, { url, active: false });
					await keepWorkerTabWarm(savedId);
					return savedId;
				} catch {
					await saveWorkerTabId(null);
				}
			}

			const [active] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			const windowId = active?.windowId;
			const siblings =
				windowId != null
					? await chrome.tabs.query({ windowId })
					: await chrome.tabs.query({ currentWindow: true });
			const tab = await chrome.tabs.create({
				url,
				active: false,
				windowId,
				index: siblings.length,
			});
			if (!tab.id) return null;
			await keepWorkerTabWarm(tab.id);
			await saveWorkerTabId(tab.id);
			return tab.id;
		} finally {
			tabEnsureInFlight = null;
		}
	})();
	return tabEnsureInFlight;
}

async function keepWorkerTabWarm(tabId: number): Promise<void> {
	try {
		await chrome.tabs.update(tabId, { autoDiscardable: false });
	} catch {
		/* tab already gone */
	}
}

async function discardWorkerTab(): Promise<void> {
	const savedId = await loadWorkerTabId();
	await saveWorkerTabId(null);
	if (savedId == null) return;
	try {
		await chrome.tabs.remove(savedId);
	} catch {
		/* already closed */
	}
}

async function discardWorkerTabIfIdle(): Promise<void> {
	const queue = await loadArticleQueue();
	const busy = queue.some(
		(item) => item.status === "pending" || item.status === "fetching",
	);
	if (!busy) await discardWorkerTab();
}

async function recoverInterruptedArticles(): Promise<void> {
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
	await updateArticleQueue((items) => {
		for (const item of items) {
			if (item.status !== "fetching" || activeIds.has(item.articleId)) continue;
			item.status = "pending";
			item.nextAt = undefined;
			item.lastError = "Background worker restarted";
		}
		return items;
	});
}

async function scheduleNext(delayMs = ARTICLE_GAP_MS): Promise<void> {
	const state = await loadHydrationState();
	const now = Date.now();
	const wait = Math.max(delayMs, msUntilHydrationAllowed(state, now));
	const wake = nextQueueWakeAt(state.queue, state, now);
	const when = now + Math.max(wait, wake ?? 0);
	try {
		await chrome.alarms.create(ALARM_NAME, { when });
	} catch {
		/* ignore */
	}
}

async function broadcastStats(): Promise<void> {
	const queue = await loadArticleQueue();
	const stats = articleQueueStats(queue);
	try {
		const tabs = await chrome.tabs.query({
			url: ["https://x.com/*", "https://twitter.com/*"],
		});
		await Promise.all(
			tabs
				.filter((tab) => tab.id != null)
				.map((tab) =>
					chrome.tabs
						.sendMessage(tab.id!, { type: "bp-article-stats", stats })
						.catch(() => {
							/* no content script in this tab */
						}),
				),
		);
	} catch {
		/* no listeners */
	}
}

async function broadcastTimelineProgress(
	job: TimelineJob,
	running: boolean,
	error?: string,
	libraryTotal?: number | null,
): Promise<void> {
	try {
		const tabs = await chrome.tabs.query({
			url: ["https://x.com/*", "https://twitter.com/*"],
		});
		await Promise.all(
			tabs
				.filter((tab) => tab.id != null)
				.map((tab) =>
					chrome.tabs
						.sendMessage(tab.id!, {
							type: "bp-timeline-progress",
							progress: {
								captured: job.captured,
								imported: job.imported,
								skipped: job.skipped,
								pages: job.pages,
								running,
								error,
								libraryTotal,
							},
						})
						.catch(() => {
							/* no content script in this tab */
						}),
				),
		);
	} catch {
		/* no matching tabs */
	}
}

async function enqueueArticlesFromTweets(
	tweets: Record<string, unknown>,
): Promise<void> {
	const articles = Object.entries(tweets)
		.map(([tweetId, tweet]) =>
			pendingArticleFromRaw(tweetId, JSON.stringify(tweet), null),
		)
		.filter((item): item is NonNullable<typeof item> => item != null);
	if (articles.length === 0) return;
	await updateArticleQueue((queue) => enqueueArticles(queue, articles));
	await broadcastStats();
	await scheduleNext();
}

async function runTimelinePages(): Promise<void> {
	if (timelineRunning) return;
	timelineRunning = true;
	try {
		let job = await idbGet<TimelineJob>(TIMELINE_JOB_KEY);
		if (!job) return;
		const settings = await loadSettings();
		if (settings.mode !== "api" || !settings.serverUrl) return;

		for (let page = 0; page < TIMELINE_PAGES_PER_RUN; page++) {
			const replay = requestForCursor(job, job.cursor);
			const response = await fetch(replay.url, {
				method: job.request.method,
				headers: job.request.headers,
				body: job.request.method === "GET" ? undefined : replay.body,
				credentials: "include",
			});
			if (!response.ok) {
				throw new Error(`X timeline request failed (${response.status})`);
			}
			const data = await response.json();
			const tweets = collectTimelineTweets(data);
			const entries = Object.entries(tweets);
			let libraryTotal: number | null = null;

			for (let index = 0; index < entries.length; index += TIMELINE_UPLOAD_BATCH) {
				const batch = Object.fromEntries(
					entries.slice(index, index + TIMELINE_UPLOAD_BATCH),
				);
				const result = await uploadPayload(
					{
						exportVersion: 2,
						exportedAt: new Date().toISOString(),
						source: job.source,
						origin: "x-background-pagination",
						page: {
							url: job.pageUrl,
							pathname: new URL(job.pageUrl).pathname,
						},
						stats: {
							tweetCount: Object.keys(batch).length,
							responseCount: 0,
						},
						tweets: batch,
						responses: [],
					},
					settings.serverUrl,
				);
				job.imported += result.imported;
				job.skipped += result.skipped;
				libraryTotal = result.total;
			}

			job.captured += entries.length;
			job.pages += 1;
			await enqueueArticlesFromTweets(tweets);
			const nextCursor = findBottomCursor(data);
			if (!nextCursor || nextCursor === job.cursor) {
				await idbDelete(TIMELINE_JOB_KEY);
				await chrome.alarms.clear(TIMELINE_ALARM);
				await broadcastTimelineProgress(job, false, undefined, libraryTotal);
				return;
			}

			job.cursor = nextCursor;
			await idbSet(TIMELINE_JOB_KEY, job);
			await broadcastTimelineProgress(job, true, undefined, libraryTotal);
		}

		await chrome.alarms.create(TIMELINE_ALARM, {
			when: Date.now() + 30_000,
		});
	} catch (error) {
		const job = await idbGet<TimelineJob>(TIMELINE_JOB_KEY);
		if (job) {
			await broadcastTimelineProgress(
				job,
				false,
				error instanceof Error ? error.message : String(error),
			);
			await chrome.alarms.create(TIMELINE_ALARM, {
				when: Date.now() + 30_000,
			});
		}
	} finally {
		timelineRunning = false;
	}
}

async function ingestPendingFromServer(): Promise<void> {
	const state = await loadHydrationState();
	if (isRateLimited(state)) return;
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return;
	const queue = await loadArticleQueue();
	const pendingCount = queue.filter(
		(item) => item.status === "pending" || item.status === "fetching",
	).length;
	if (pendingCount >= 25) return;
	try {
		const limit = pendingCount === 0 ? 10 : 5;
		const pending = await fetchPendingArticles(settings.serverUrl, limit);
		if (pending.length === 0) return;
		await updateArticleQueue((queue) => enqueueArticles(queue, pending));
		await broadcastStats();
	} catch {
		/* server offline */
	}
}

async function handleArticleUnavailable(
	articleId: string,
	tabId?: number,
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
	await broadcastStats();
	await scheduleNext();
	return true;
}

async function hydrateArticleDirect(
	next: ArticleQueueItem,
): Promise<"ok" | "unavailable" | "retry" | "tab"> {
	const template = await idbGet<ArticleRequestTemplate>(ARTICLE_TEMPLATE_KEY);
	if (!template) return "tab";
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
			const state = await loadHydrationState();
			const delay = parseRetryAfterMs(
				response.headers.get("retry-after"),
				ARTICLE_RATE_LIMIT_MS,
			);
			await noteRateLimited(delay);
			await updateArticleQueue((items) =>
				markArticleRateLimited(
					items,
					next.articleId,
					"X rate limited article request (429)",
					Date.now(),
					state.rateLimitHits ?? 1,
				),
			);
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
			await handleArticleUnavailable(next.articleId);
			return "unavailable";
		}
		const article = findHydratedArticleResult(data);
		if (!article || !hasFullArticleBody(article)) {
			return "tab";
		}
		await uploadPayload(
			buildArticleHydrationPayload(
				next.tweetId,
				article,
				"bookmark",
				next.url,
			),
			settings.serverUrl,
		);
		await updateArticleQueue((items) =>
			markArticleSuccess(items, next.articleId),
		);
		await noteArticleCompleted();
		await broadcastStats();
		await scheduleNext();
		return "ok";
	} catch {
		return "tab";
	}
}

async function hydrateNext(): Promise<void> {
	if (hydrating || (await loadOpenedTabs()).length > 0) return;
	const state = await loadHydrationState();
	if (isRateLimited(state)) {
		await scheduleNext(msUntilHydrationAllowed(state));
		return;
	}
	hydrating = true;
	try {
		const queue = await loadArticleQueue();
		let next = pickNextArticle(queue);
		if (!next) {
			await ingestPendingFromServer();
			const refreshed = await loadArticleQueue();
			next = pickNextArticle(refreshed);
			if (!next && refreshed.some((item) => item.status === "fetching")) {
				await scheduleNext(5_000);
				return;
			}
			const wake = nextQueueWakeAt(refreshed, await loadHydrationState());
			if (!next && wake != null) {
				await scheduleNext(wake);
				return;
			}
			if (!next && refreshed.some((item) => item.status === "failed")) {
				await scheduleNext(ARTICLE_POLL_IDLE_MS);
				return;
			}
		}
		if (!next) {
			await scheduleNext(ARTICLE_POLL_IDLE_MS);
			return;
		}

		await updateArticleQueue((items) => markArticleFetching(items, next.articleId));
		await broadcastStats();

		try {
			const direct = await hydrateArticleDirect(next);
			if (direct === "ok" || direct === "unavailable" || direct === "retry") {
				return;
			}
			if (captureScrollActive) {
				await updateArticleQueue((items) => {
					const item = items.find((entry) => entry.articleId === next.articleId);
					if (item?.status === "fetching") {
						item.status = "pending";
						item.attempts = Math.max(0, item.attempts - 1);
					}
					return items;
				});
				await broadcastStats();
				await scheduleNext(CAPTURE_BUSY_RETRY_MS);
				return;
			}
			const tabId = await ensureHydrationTab(next.url);
			if (tabId == null) {
				await updateArticleQueue((items) =>
					markArticleFailure(items, next.articleId, "Failed to open tab"),
				);
				await scheduleNext();
				return;
			}
			await saveOpenedTabs([{
				tabId,
				articleId: next.articleId,
				tweetId: next.tweetId,
				url: next.url,
			}]);
			await chrome.alarms.create(`${ARTICLE_TIMEOUT_PREFIX}${tabId}`, {
				when: Date.now() + ARTICLE_TAB_TIMEOUT_MS,
			});
			try {
				await waitForTabLoad(tabId, ARTICLE_TAB_LOAD_MS, next.url);
			} catch {
				const refreshed = await loadArticleQueue();
				const item = refreshed.find((entry) => entry.articleId === next.articleId);
				if (item?.status === "ok") return;
				if (!(await findOpenedTab(tabId))) return;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to open article tab";
			await updateArticleQueue((items) =>
				markArticleFailure(items, next.articleId, msg),
			);
			await scheduleNext();
		}
	} finally {
		hydrating = false;
	}
}

async function closeHydrationTab(tabId: number): Promise<void> {
	await removeOpenedTab(tabId);
	await chrome.alarms.clear(`${ARTICLE_TIMEOUT_PREFIX}${tabId}`);
	await discardWorkerTabIfIdle();
}

async function failTab(tabId: number, error: string): Promise<void> {
	const opened = await findOpenedTab(tabId);
	if (!opened) return;
	await closeHydrationTab(tabId);
	await updateArticleQueue((items) =>
		markArticleFailure(items, opened.articleId, error),
	);
	await broadcastStats();
	await scheduleNext();
}

async function captureArticleBody(
	article: GraphQLArticleResult,
	senderTabId?: number,
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
		);
		await uploadPayload(payload, settings.serverUrl);
		await updateArticleQueue((items) => markArticleSuccess(items, articleId));
		await noteArticleCompleted();
		if (tabId != null) await closeHydrationTab(tabId);
		await broadcastStats();
		await scheduleNext();
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Upload failed";
		if (tabId != null) await failTab(tabId, msg);
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	void (async () => {
		switch (message?.type) {
			case "bp-state-load":
				return { state: await idbGet<CaptureState>(CAPTURE_KEY) };
			case "bp-state-save":
				await idbSet(CAPTURE_KEY, message.state);
				return { ok: true };
			case "bp-state-clear":
				await idbDelete(CAPTURE_KEY);
				return { ok: true };
			case "bp-sync":
				return await syncPayload({
					payload: message.payload as ExportPayload,
					serverUrl: String(message.serverUrl),
				});
			case "bp-fetch-total":
				return { total: await fetchServerTotal(String(message.serverUrl)) };
			case "bp-timeline-seed": {
				const candidate = createTimelineJob(
					message.detail as CaptureEventDetail,
					message.source,
					String(message.pageUrl),
				);
				if (!candidate) return { accepted: false };
				const existing = await idbGet<TimelineJob>(TIMELINE_JOB_KEY);
				if (existing) {
					existing.request = candidate.request;
					existing.pageUrl = candidate.pageUrl;
					await idbSet(TIMELINE_JOB_KEY, existing);
					await runTimelinePages();
					return { accepted: true, progress: existing };
				}
				await idbSet(TIMELINE_JOB_KEY, candidate);
				await runTimelinePages();
				return { accepted: true, progress: candidate };
			}
			case "bp-enqueue-articles": {
				const incoming = Array.isArray(message.articles) ? message.articles : [];
				await updateArticleQueue((queue) => enqueueArticles(queue, incoming));
				await broadcastStats();
				await scheduleNext();
				return { ok: true };
			}
			case "bp-article-template": {
				const template = createArticleRequestTemplate(
					message.detail as CaptureEventDetail,
					String(message.articleId),
				);
				if (!template) return { accepted: false };
				const existing = await idbGet<ArticleRequestTemplate>(ARTICLE_TEMPLATE_KEY);
				if (
					existing &&
					/ArticleEntity/i.test(existing.url) &&
					!/ArticleEntity/i.test(template.url)
				) {
					return { accepted: false };
				}
				await idbSet(ARTICLE_TEMPLATE_KEY, template);
				return { accepted: true };
			}
			case "bp-article-body":
				await captureArticleBody(
					message.article as GraphQLArticleResult,
					sender.tab?.id,
				);
				return { ok: true };
			case "bp-article-unavailable":
				return {
					removed: await handleArticleUnavailable(
						String(message.articleId),
						sender.tab?.id,
					),
				};
			case "bp-article-retry":
				await updateArticleQueue((queue) => retryFailedArticles(queue));
				await broadcastStats();
				await scheduleNext();
				return { ok: true };
			case "bp-refresh-articles":
				await ingestPendingFromServer();
				await scheduleNext();
				return { ok: true };
			case "bp-capture-scroll": {
				captureScrollActive = Boolean(message.active);
				if (!captureScrollActive) {
					await scheduleNext();
				}
				return { ok: true };
			}
			case "bp-article-rate-limited": {
				const delay = parseRetryAfterMs(
					message.retryAfter != null ? String(message.retryAfter) : null,
					ARTICLE_RATE_LIMIT_MS,
				);
				await noteRateLimited(delay);
				const opened = await loadOpenedTabs();
				if (opened.length > 0) {
					await failTab(opened[0]!.tabId, "X rate limited (429)");
				}
				await scheduleNext(delay);
				return { ok: true };
			}
			case "bp-article-stats-request":
				return { stats: articleQueueStats(await loadArticleQueue()) };
			default:
				return null;
		}
	})()
		.then((result) => sendResponse({ ok: true, result }))
		.catch((err) =>
			sendResponse({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === SYNC_RETRY_ALARM) {
		void retryPendingUpload();
		return;
	}
	if (alarm.name.startsWith(ARTICLE_TIMEOUT_PREFIX)) {
		const tabId = Number(alarm.name.slice(ARTICLE_TIMEOUT_PREFIX.length));
		if (Number.isInteger(tabId)) {
			void failTab(tabId, "Timed out waiting for article body");
		}
		return;
	}
	if (alarm.name === TIMELINE_ALARM) {
		void runTimelinePages();
		return;
	}
	if (alarm.name === ALARM_NAME) {
		queueHydration();
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	void (async () => {
		const workerId = await loadWorkerTabId();
		if (workerId === tabId) await saveWorkerTabId(null);
		const opened = await findOpenedTab(tabId);
		if (opened) await failTab(tabId, "Article tab closed");
	})();
});

chrome.runtime.onStartup.addListener(() => {
	void runTimelinePages();
	void bootstrapArticles();
});

void bootstrapArticles();
void runTimelinePages();
