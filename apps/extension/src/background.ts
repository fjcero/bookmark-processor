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
	retryFailedArticles,
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
	fetchServerTotal,
	uploadPayload,
	type CaptureState,
	type ExportPayload,
} from "@repo/import/capture/engine";
import type { CaptureEventDetail } from "@repo/import/capture/hooks-events";
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
import { idbDelete, idbGet, idbSet } from "./idb";
import {
	enqueueImportPayload,
	IMPORT_QUEUE_ALARM,
	importWorkerProgress,
	loadImportWorkerState,
	processNextImport,
} from "./import-worker";
import {
	createArticleRequestTemplate,
	requestForArticle,
	type ArticleRequestTemplate,
} from "./article-replay";
import { loadSettings } from "./storage";
import {
	applySyncRevocations,
	buildExtensionStatusReport,
	postSyncStatus,
} from "./sync-status";

const CAPTURE_KEY = "capture";
const PENDING_UPLOAD_KEY = "pending-upload";
const SYNC_STATUS_ALARM = "bp-sync-status";
const SYNC_STATUS_PUSH_ALARM = "bp-sync-status-push";
const SYNC_STATUS_ERROR_KEY = "bp-sync-status-error";
const LEGACY_STORAGE_KEY = "x-export-v2-state";
const ARTICLE_TABS_KEY = "article-tabs";
const ARTICLE_WORKER_TAB_KEY = "article-worker-tab";
const ARTICLE_TEMPLATE_KEY = "article-request-template";
const ARTICLE_TIMEOUT_PREFIX = "bp-article-timeout:";

interface OpenedArticleTab {
	tabId: number;
	articleId: string;
	tweetId: string;
	url: string;
}

const CAPTURE_SCROLL_KEY = "bp-capture-scroll-active";

async function broadcastLibraryArticleCount(count: number): Promise<void> {
	const tabs = await chrome.tabs.query({
		url: ["https://x.com/*", "https://twitter.com/*"],
	});
	await Promise.all(
		tabs
			.filter((tab) => tab.id != null)
			.map((tab) =>
				chrome.tabs
					.sendMessage(tab.id!, {
						type: "bp-library-article-count",
						count,
					})
					.catch(() => {
						/* no content script */
					}),
			),
	);
}

async function syncWithServer(lastError?: string): Promise<void> {
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return;

	const queue = await loadArticleQueue();
	const importWorker = await loadImportWorkerState();
	const captureScrollActive =
		(await idbGet<boolean>(CAPTURE_SCROLL_KEY)) ?? false;
	const report = await buildExtensionStatusReport({
		articles: articleQueueStats(queue),
		articleQueue: queue
			.filter((item) => item.status !== "ok")
			.slice(0, 100),
		importWorker: importWorkerProgress(importWorker),
		captureScrollActive,
		lastError,
	});

	const response = await postSyncStatus(settings.serverUrl, report);
	if (!response) return;
	await broadcastLibraryArticleCount(
		response.library.articlesNeedingBody,
	);

	const acked = await applySyncRevocations(response.revocations);
	if (acked.length > 0) {
		await postSyncStatus(settings.serverUrl, report, acked);
	}
}

function scheduleSyncStatusPush(lastError?: string): void {
	void (async () => {
		if (lastError) await idbSet(SYNC_STATUS_ERROR_KEY, lastError);
		const existing = await chrome.alarms.get(SYNC_STATUS_PUSH_ALARM);
		if (existing) return;
		await chrome.alarms.create(SYNC_STATUS_PUSH_ALARM, {
			when: Date.now() + 30_000,
		});
	})();
}

async function bootstrapArticles(): Promise<void> {
	await recoverInterruptedArticles();
	await ingestPendingFromServer();
	await scheduleNext(5_000);
	void syncWithServer();
}

async function migrateLegacyPendingUpload(): Promise<void> {
	const pending = await idbGet<{
		payload: ExportPayload;
		serverUrl: string;
	}>(PENDING_UPLOAD_KEY);
	if (!pending) return;
	await enqueueImportPayload(pending.payload, pending.serverUrl);
	await idbDelete(PENDING_UPLOAD_KEY);
	await chrome.alarms.clear("bp-sync-retry");
}

function queueHydration(): void {
	void hydrateNext();
}

chrome.runtime.onInstalled.addListener(() => {
	chrome.storage.local.remove(LEGACY_STORAGE_KEY).catch(() => {
		/* ignore */
	});
	void chrome.alarms.create(SYNC_STATUS_ALARM, { periodInMinutes: 1 });
	void migrateLegacyPendingUpload();
	void processNextImport();
	void bootstrapArticles();
});

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

async function scheduleNext(delayMs = ARTICLE_GAP_MS): Promise<void> {
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
	scheduleSyncStatusPush();
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
	await releaseArticleLease(articleId);
	await broadcastStats();
	await scheduleNext();
	return true;
}

async function hydrateArticleDirect(
	next: ArticleQueueItem,
): Promise<"ok" | "unavailable" | "retry" | "tab"> {
	const template = await idbGet<ArticleRequestTemplate>(ARTICLE_TEMPLATE_KEY);
	if (!template) return "tab";
	if (!isSafeArticleReplayUrl(template.url) || isGraphqlWriteOperation(template.url)) {
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
			await handleArticleUnavailable(next.articleId);
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
		await broadcastStats();
		await scheduleNext();
		return "ok";
	} catch {
		return "tab";
	}
}

async function hydrateNext(): Promise<void> {
	if ((await loadOpenedTabs()).length > 0) return;
	const state = await loadHydrationState();
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
		return;
	}

	await broadcastStats();

	try {
		const direct = await hydrateArticleDirect(next);
		if (direct === "ok" || direct === "unavailable" || direct === "retry") {
			return;
		}
		const tabId = await ensureHydrationTab(next.url);
		if (tabId == null) {
			await updateArticleQueue((items) =>
				markArticleFailure(items, next.articleId, "Failed to open tab"),
			);
			await releaseArticleLease(next.articleId);
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
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Failed to open article tab";
		await updateArticleQueue((items) =>
			markArticleFailure(items, next.articleId, msg),
		);
		await releaseArticleLease(next.articleId);
		await scheduleNext();
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
	await releaseArticleLease(opened.articleId);
	await broadcastStats();
	await scheduleNext();
}

async function captureArticleBody(
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

async function handleWorkerMessage(
	message: Record<string, unknown>,
	sender: chrome.runtime.MessageSender,
): Promise<unknown> {
	switch (message.type) {
			case "bp-state-load":
				return { state: await idbGet<CaptureState>(CAPTURE_KEY) };
			case "bp-state-save":
				await idbSet(CAPTURE_KEY, message.state);
				return { ok: true };
			case "bp-state-clear":
				await idbDelete(CAPTURE_KEY);
				return { ok: true };
			case "bp-import-enqueue": {
				await enqueueImportPayload(
					message.payload as ExportPayload,
					String(message.serverUrl),
				);
				const state = await processNextImport();
				scheduleSyncStatusPush(state.lastError);
				return importWorkerProgress(state);
			}
			case "bp-fetch-total":
				return { total: await fetchServerTotal(String(message.serverUrl)) };
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
				if (!isSafeArticleReplayUrl(template.url)) {
					return { accepted: false };
				}
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
					message.raw,
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
				const active = Boolean(message.active);
				await idbSet(CAPTURE_SCROLL_KEY, active);
				if (!active) {
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
				const limited = await loadHydrationState();
				const opened = await loadOpenedTabs();
				if (opened.length > 0) {
					const current = opened[0]!;
					await closeHydrationTab(current.tabId);
					await updateArticleQueue((items) =>
						markArticleRateLimited(
							items,
							current.articleId,
							"X rate limited article request (429)",
							Date.now(),
							limited.rateLimitHits ?? 1,
						),
					);
					await releaseArticleLease(current.articleId);
					await broadcastStats();
				}
				await scheduleNext(delay);
				return { ok: true };
			}
			case "bp-article-stats-request":
				return { stats: articleQueueStats(await loadArticleQueue()) };
			default:
				return null;
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	void (async () => {
		try {
			const result = await handleWorkerMessage(message, sender);
			sendResponse({ ok: true, result });
		} catch (err) {
			sendResponse({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	})();
	return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === IMPORT_QUEUE_ALARM) {
		void (async () => {
			const state = await processNextImport();
			scheduleSyncStatusPush(state.lastError);
		})();
		return;
	}
	if (alarm.name.startsWith(ARTICLE_TIMEOUT_PREFIX)) {
		const tabId = Number(alarm.name.slice(ARTICLE_TIMEOUT_PREFIX.length));
		if (Number.isInteger(tabId)) {
			void failTab(tabId, "Timed out waiting for article body");
		}
		return;
	}
	if (alarm.name === ALARM_NAME) {
		queueHydration();
		return;
	}
	if (alarm.name === SYNC_STATUS_ALARM) {
		void syncWithServer();
		return;
	}
	if (alarm.name === SYNC_STATUS_PUSH_ALARM) {
		void (async () => {
			const error = await idbGet<string>(SYNC_STATUS_ERROR_KEY);
			await idbDelete(SYNC_STATUS_ERROR_KEY);
			await syncWithServer(error ?? undefined);
		})();
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
	void chrome.alarms.create(SYNC_STATUS_ALARM, { periodInMinutes: 1 });
	void migrateLegacyPendingUpload();
	void processNextImport();
	void bootstrapArticles();
});

void migrateLegacyPendingUpload();
void bootstrapArticles();
void processNextImport();
