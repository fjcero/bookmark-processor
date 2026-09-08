import {
	CaptureEngine,
	downloadPayload,
	runAutoScroll,
} from "@repo/import/capture/engine";
import {
	articleFromDocument,
	hasFullArticleBody,
	isArticleUnavailableDocument,
	isUnsupportedClientDocument,
	pendingArticleFromRaw,
	type GraphQLArticleResult,
	type ImportWorkerProgress,
	isImportableTweet,
} from "@repo/import";
import { clearCaptureQueue } from "@repo/import/capture/hooks-events";
import {
	createBackgroundStorageAdapter,
	enqueueImportsInBackground,
	fetchLibraryStatsInBackground,
	filterKnownExternalIdsInBackground,
	hydrateLibraryCacheInBackground,
	reconcileArticlesInBackground,
} from "./core/background-client";
import {
	isLibraryCached,
	loadLibraryCache,
	saveLibraryCache,
} from "./core/library-cache";
import { loadSettings } from "./core/storage";
import {
	mountSidebarUiWithRetry,
	setArticleStatus,
	setAutoScrollUi,
	setSyncRetryVisible,
	setSyncStatus,
	showToast,
	type SidebarUiRefs,
	unmountSidebarUi,
	updateLibraryStats,
	updateSessionStats,
} from "./sidebar-ui";
import {
	mountSyncDock,
	setDockArticleQueue,
	setDockAutoScrollUi,
	setDockSyncRetryVisible,
	setDockSyncStatus,
	type SyncDockRefs,
	unmountSyncDock,
	updateDockLibraryStats,
	updateDockSessionStats,
} from "./sync-dock-ui";
import { clickTimelineRetry } from "./timeline-recovery";

const SYNC_INTERVAL_MS = 1500;

function isArticlePage(): boolean {
	if (
		!location.hostname.includes("twitter.com") &&
		!location.hostname.includes("x.com")
	) {
		return false;
	}
	return /\/i\/article\/\d+/.test(location.pathname);
}

function isHistoryPage(): boolean {
	return location.pathname.includes("/history");
}

function isLikesPage(): boolean {
	return location.pathname.includes("/likes");
}

function isLikelyCapturePath(): boolean {
	if (
		!location.hostname.includes("twitter.com") &&
		!location.hostname.includes("x.com")
	) {
		return false;
	}
	return (
		location.pathname.includes("/bookmarks") ||
		location.pathname.includes("/likes") ||
		location.pathname.includes("/with_replies") ||
		location.pathname.includes("/history")
	);
}

async function isCapturePage(): Promise<boolean> {
	if (!isLikelyCapturePath()) return false;
	const settings = await loadSettings();
	if (isHistoryPage()) return settings.captureHistory;
	if (isLikesPage()) return settings.captureLikes;
	return true;
}

let engine: CaptureEngine | null = null;
let sidebar: SidebarUiRefs | null = null;
let syncDock: SyncDockRefs | null = null;
let autoScrolling = false;
let uiMounted = false;
let stopSidebarRetry: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let syncQueued = false;
let retryObserver: MutationObserver | null = null;
let sessionImported = 0;
let sessionSkipped = 0;
const sessionAlreadyHadIds = new Set<string>();
let knownCheckTimer: ReturnType<typeof setTimeout> | null = null;
const pendingKnownCheck = new Set<string>();
let libraryStats: {
	posts: number | null;
	articles: number | null;
	total: number | null;
} = { posts: null, articles: null, total: null };

function reportCaptureScroll(active: boolean): void {
	try {
		void chrome.runtime.sendMessage({ type: "bp-capture-scroll", active });
	} catch {
		/* background unavailable */
	}
}

function hasCaptureUi(): boolean {
	return Boolean(sidebar || syncDock);
}

function applyArticleStats(stats: {
	pending: number;
	fetching: number;
	ok: number;
	failed: number;
	total: number;
}): void {
	const remaining = stats.pending + stats.fetching;
	if (sidebar) setArticleStatus(sidebar, stats);
	if (syncDock) setDockArticleQueue(syncDock, remaining);
}

function renderSessionProgress(): void {
	if (!engine) return;
	const pending = engine.tweetCount();
	const sidebarStats = {
		new: sessionImported,
		skipped: sessionAlreadyHadIds.size + sessionSkipped,
		pending,
	};
	if (sidebar) updateSessionStats(sidebar, sidebarStats);
	if (syncDock) {
		updateDockSessionStats(syncDock, {
			seen: engine.observedCount(),
			new: sessionImported,
			pending,
		});
	}
}

function noteAlreadyInLibrary(tweetId: string): void {
	sessionAlreadyHadIds.add(tweetId);
	renderSessionProgress();
}

function applyLibraryStats(partial: {
	posts?: number | null;
	articles?: number | null;
	total?: number | null;
}): void {
	if (partial.posts != null) libraryStats.posts = partial.posts;
	if (partial.articles != null) libraryStats.articles = partial.articles;
	if (partial.total != null) libraryStats.total = partial.total;
	if (sidebar) updateLibraryStats(sidebar, libraryStats);
	if (syncDock) updateDockLibraryStats(syncDock, libraryStats);
}

function setCaptureAutoScroll(
	state: "idle" | "running" | "done",
	count?: number,
): void {
	if (sidebar) setAutoScrollUi(sidebar, state, count);
	if (syncDock) setDockAutoScrollUi(syncDock, state, count);
}

function setCaptureSyncStatus(message: string): void {
	if (sidebar) setSyncStatus(sidebar, message);
	if (syncDock) setDockSyncStatus(syncDock, message);
}

function setCaptureSyncRetryVisible(visible: boolean): void {
	if (sidebar) setSyncRetryVisible(sidebar, visible);
	if (syncDock) setDockSyncRetryVisible(syncDock, visible);
}

function trackPendingCount(count: number): void {
	renderSessionProgress();
}

function applyImportProgress(progress: ImportWorkerProgress): void {
	if (progress.completedIds?.length) {
		void saveLibraryCache(progress.completedIds);
	}
	if (progress.completedIds?.length && engine) {
		engine.removeSynced(progress.completedIds);
		clearCaptureQueue();
	}
	sessionImported += progress.importedDelta ?? 0;
	sessionSkipped += progress.skippedDelta ?? 0;
	applyLibraryStats({
		total: progress.libraryTotal,
		posts: progress.libraryPosts,
		articles: progress.libraryArticles,
	});
	renderSessionProgress();
	if (!hasCaptureUi()) return;

	if (progress.lastError) {
		setCaptureSyncRetryVisible(true);
		setCaptureSyncStatus("Background import paused, retrying");
		return;
	}
	setCaptureSyncRetryVisible(false);
}

function enqueueCapturedArticles(): void {
	if (!engine) return;
	const payload = engine.buildPayload();
	const articles: Array<{ tweetId: string; articleId: string; url: string }> =
		[];
	for (const [tweetId, tweet] of Object.entries(payload.tweets)) {
		if (engine.isSynced(tweetId) || isLibraryCached(tweetId)) continue;
		const pending = pendingArticleFromRaw(tweetId, JSON.stringify(tweet), null);
		if (pending) articles.push(pending);
	}
	if (articles.length === 0) return;
	try {
		void chrome.runtime.sendMessage({ type: "bp-enqueue-articles", articles });
	} catch {
		/* background unavailable */
	}
}

async function flushKnownCheck(): Promise<void> {
	knownCheckTimer = null;
	if (!engine || pendingKnownCheck.size === 0) return;
	const ids = [...pendingKnownCheck];
	pendingKnownCheck.clear();
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return;
	const known = await filterKnownExternalIdsInBackground(
		settings.serverUrl,
		ids,
	);
	if (known.length > 0) {
		await saveLibraryCache(known);
		engine.markSynced(known);
		for (const id of known) sessionAlreadyHadIds.add(id);
		renderSessionProgress();
	}
}

function queueKnownCheck(tweetId: string): void {
	if (!engine || engine.isSynced(tweetId) || isLibraryCached(tweetId)) return;
	pendingKnownCheck.add(tweetId);
	if (knownCheckTimer) clearTimeout(knownCheckTimer);
	knownCheckTimer = setTimeout(() => {
		void flushKnownCheck();
	}, 400);
}

async function prepareCaptureSession(engine: CaptureEngine): Promise<void> {
	await loadLibraryCache();
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return;
	try {
		await hydrateLibraryCacheInBackground(settings.serverUrl);
		engine.markSynced([...(await loadLibraryCache())]);
		await reconcileArticlesInBackground(settings.serverUrl);
		void refreshArticleStats();
	} catch (err) {
		console.warn(
			"[Bookmark Processor] Library cache warm-up failed:",
			err instanceof Error ? err.message : err,
		);
	}
}

function watchArticleAvailability(articleId: string): void {
	let reported = false;
	const report = () => {
		if (reported) return;
		reported = true;
		try {
			void chrome.runtime.sendMessage({
				type: "bp-article-unavailable",
				articleId,
			});
		} catch {
			/* background unavailable */
		}
	};

	const check = () => {
		if (isArticleUnavailableDocument(document.body)) {
			report();
			return true;
		}
		return false;
	};

	window.setTimeout(() => {
		if (check()) return;
		const observer = new MutationObserver(() => {
			if (check()) observer.disconnect();
		});
		if (document.body) {
			observer.observe(document.body, { childList: true, subtree: true });
		}
		window.setTimeout(() => observer.disconnect(), 20_000);
	}, 8_000);
}

function startArticlePageCapture(): void {
	const pageArticleId =
		location.pathname.match(/\/i\/article\/(\d+)/)?.[1] ?? "";
	let bodySent = false;

	const sendArticleBody = (article: GraphQLArticleResult, raw?: unknown) => {
		if (bodySent || !hasFullArticleBody(article)) return;
		bodySent = true;
		try {
			void chrome.runtime.sendMessage({
				type: "bp-article-body",
				article,
				raw,
			});
		} catch {
			/* ignore */
		}
	};

	const articleEngine = new CaptureEngine({
		storeResponses: false,
		onCapture: (detail) => {
			if (!pageArticleId) return;
			try {
				void chrome.runtime.sendMessage({
					type: "bp-article-template",
					detail,
					articleId: pageArticleId,
				});
			} catch {
				/* ignore */
			}
		},
		onArticleBody: (article: GraphQLArticleResult, raw: unknown) => {
			sendArticleBody(
				{
					...article,
					hydration_source: article.hydration_source ?? "graphql",
				},
				raw,
			);
		},
	});
	articleEngine.start();
	if (pageArticleId) {
		watchArticleHtml(pageArticleId, sendArticleBody, () => bodySent);
		watchArticleAvailability(pageArticleId);
	}
}

function watchArticleHtml(
	articleId: string,
	sendArticleBody: (article: GraphQLArticleResult) => void,
	alreadySent: () => boolean,
): void {
	let lastSignature = "";
	let stableSince = 0;

	const reveal = () => {
		const column = document.querySelector('[data-testid="primaryColumn"]');
		if (column) column.scrollTop = column.scrollHeight;
		window.scrollTo(0, document.documentElement.scrollHeight);
	};

	const tryExtract = (requireStable: boolean) => {
		if (alreadySent()) return true;
		if (
			isUnsupportedClientDocument(document.body) ||
			isArticleUnavailableDocument(document.body)
		) {
			return false;
		}
		const article = articleFromDocument(document, articleId);
		if (!article) return false;
		const signature = JSON.stringify(article.content_state?.blocks ?? []);
		const now = Date.now();
		if (signature !== lastSignature) {
			lastSignature = signature;
			stableSince = now;
			if (requireStable) return false;
		}
		if (requireStable && now - stableSince < 800) return false;
		sendArticleBody(article);
		return alreadySent();
	};

	reveal();
	const interval = window.setInterval(() => {
		reveal();
		if (tryExtract(true)) {
			window.clearInterval(interval);
			observer.disconnect();
		}
	}, 500);
	const observer = new MutationObserver(() => {
		tryExtract(true);
	});
	if (document.body) {
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}
	window.setTimeout(() => {
		observer.disconnect();
		window.clearInterval(interval);
		tryExtract(false);
	}, 40_000);
}

async function refreshLibraryStats(): Promise<void> {
	if (!hasCaptureUi()) return;
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) {
		libraryStats = { posts: null, articles: null, total: null };
		if (sidebar) updateLibraryStats(sidebar, null);
		if (syncDock) updateDockLibraryStats(syncDock, null);
		return;
	}
	try {
		const stats = await fetchLibraryStatsInBackground(settings.serverUrl);
		if (!hasCaptureUi()) return;
		if (!stats) {
			if (sidebar) updateLibraryStats(sidebar, null);
			if (syncDock) updateDockLibraryStats(syncDock, null);
			return;
		}
		applyLibraryStats(stats);
	} catch {
		if (sidebar) updateLibraryStats(sidebar, null);
		if (syncDock) updateDockLibraryStats(syncDock, null);
	}
}

function clearSyncTimer(): void {
	if (syncTimer) {
		clearTimeout(syncTimer);
		syncTimer = null;
	}
}

function scheduleAutoSync(): void {
	void (async () => {
		try {
			const settings = await loadSettings();
			if (
				!settings.autoSync ||
				settings.mode !== "api" ||
				!settings.serverUrl
			) {
				return;
			}
			if (syncing) {
				syncQueued = true;
				return;
			}
			// Fixed-window batching: continuous arrivals must not postpone sync forever.
			if (syncTimer) return;
			syncTimer = setTimeout(() => {
				syncTimer = null;
				void performSync({ auto: true });
			}, SYNC_INTERVAL_MS);
		} catch {
			/* extension reloaded while this tab was open */
		}
	})();
}

function startRetryWatcher(): void {
	stopRetryWatcher();
	retryObserver = new MutationObserver(() => {
		if (autoScrolling) clickTimelineRetry();
	});
	const col = document.querySelector('[data-testid="primaryColumn"]');
	if (col) {
		retryObserver.observe(col, { childList: true, subtree: true });
	}
}

function stopRetryWatcher(): void {
	retryObserver?.disconnect();
	retryObserver = null;
}

async function recoverTimeline(): Promise<boolean> {
	return clickTimelineRetry();
}

async function performSync(opts: { auto?: boolean; manual?: boolean } = {}) {
	if (!engine || !hasCaptureUi()) return;
	let workerPaused = false;
	if (syncing) {
		syncQueued = true;
		return;
	}

	const pendingPayload = engine.buildPayload();
	const tweetEntries = Object.entries(pendingPayload.tweets);
	const shellIds = tweetEntries
		.filter(([, tweet]) => !isImportableTweet(tweet))
		.map(([id]) => id);
	if (shellIds.length > 0) {
		engine.discard(shellIds);
	}
	let importableTweets = Object.fromEntries(
		tweetEntries.filter(([, tweet]) => isImportableTweet(tweet)),
	);

	const settings = await loadSettings();

	if (settings.mode === "api" && settings.serverUrl) {
		try {
			const known = await filterKnownExternalIdsInBackground(
				settings.serverUrl,
				Object.keys(importableTweets),
			);
			if (known.length > 0) {
				for (const id of known) sessionAlreadyHadIds.add(id);
				engine.markSynced(known);
				importableTweets = Object.fromEntries(
					Object.entries(importableTweets).filter(([id]) => !known.includes(id)),
				);
				renderSessionProgress();
			}
		} catch {
			/* offline — rely on local synced cache */
		}
	}

	const pendingCount = Object.keys(importableTweets).length;
	if (pendingCount === 0) {
		if (opts.manual) showToast("Nothing to sync yet. Scroll first.");
		return;
	}

	if (settings.mode === "download") {
		downloadPayload({ ...pendingPayload, tweets: importableTweets });
		showToast(`Downloaded ${pendingCount} ${engine.label}`);
		clearCaptureQueue();
		await engine.reset();
		autoScrolling = false;
		renderSessionProgress();
		setCaptureAutoScroll("idle");
		return;
	}

	if (!settings.serverUrl) {
		if (opts.manual) showToast("Set server URL in extension popup");
		return;
	}

	clearSyncTimer();
	syncing = true;
	setCaptureSyncRetryVisible(false);

	try {
		const progress = await enqueueImportsInBackground(
			{ ...pendingPayload, tweets: importableTweets },
			settings.serverUrl,
		);
		applyImportProgress(progress);
		if (progress.lastError) {
			workerPaused = true;
			return;
		}
	} catch (err) {
		workerPaused = true;
		const msg = err instanceof Error ? err.message : "Sync failed";
		setCaptureSyncStatus("Sync failed. Click Retry or wait.");
		setCaptureSyncRetryVisible(true);
		if (opts.manual || !opts.auto) showToast(msg);
		if (settings.autoSync && engine.tweetCount() > 0) {
			clearSyncTimer();
			syncTimer = setTimeout(() => {
				syncTimer = null;
				void performSync({ auto: true });
			}, 8000);
		}
	} finally {
		syncing = false;
		if (!workerPaused && (syncQueued || engine.tweetCount() > 0)) {
			syncQueued = false;
			scheduleAutoSync();
		}
	}
}

function handleAutoScroll(): void {
	if (!engine || !hasCaptureUi()) return;
	if (autoScrolling) {
		autoScrolling = false;
		stopRetryWatcher();
		setCaptureAutoScroll("idle");
		reportCaptureScroll(false);
		return;
	}
	autoScrolling = true;
	reportCaptureScroll(true);
	startRetryWatcher();
	setCaptureAutoScroll("running");
	void (async () => {
		const settings = await loadSettings();
		if (!engine || !hasCaptureUi()) return;
		await runAutoScroll(
			engine,
			(_count, done) => {
				if (!engine || !hasCaptureUi()) return;
				renderSessionProgress();
				if (done) {
					autoScrolling = false;
					reportCaptureScroll(false);
					stopRetryWatcher();
					setCaptureAutoScroll("done", engine.observedCount());
					void performSync({ auto: true });
				}
			},
			() => autoScrolling,
			{
				scrollDelayMs: settings.scrollDelayMs,
				onStagnant: recoverTimeline,
			},
		);
	})();
}

async function refreshArticleStats(): Promise<void> {
	try {
		const response = await chrome.runtime.sendMessage({
			type: "bp-article-stats-request",
		});
		const stats = response?.result?.stats ?? response?.stats;
		if (stats) applyArticleStats(stats);
	} catch {
		/* background unavailable */
	}
}

function mountCaptureUi(): void {
	if (uiMounted || !engine) return;

	const handlers = {
		onSyncRetry: () => void performSync({ manual: true }),
		onAutoScroll: handleAutoScroll,
	};

	if (isHistoryPage()) {
		syncDock = mountSyncDock({
			...handlers,
			onPanelOpen: () => {
				renderSessionProgress();
				void refreshLibraryStats();
			},
		});
		uiMounted = true;
		renderSessionProgress();
		void refreshLibraryStats();
		void refreshArticleStats();
		return;
	}

	const label = engine.label;
	stopSidebarRetry = mountSidebarUiWithRetry(
		{
			label,
			...handlers,
		},
		(refs) => {
			sidebar = refs;
			uiMounted = true;
			renderSessionProgress();
			void refreshLibraryStats();
			void refreshArticleStats();
		},
	);
}

function mountUi(): void {
	mountCaptureUi();
}

async function startCapture(): Promise<void> {
	if (!(await isCapturePage())) return;
	if (engine) {
		showToast("Capture already active");
		return;
	}
	engine = new CaptureEngine({
		storage: createBackgroundStorageAdapter(),
		storeResponses: false,
		isLibraryCached,
		onAlreadyInLibrary: noteAlreadyInLibrary,
		onTweetObserved: (tweetId) => {
			renderSessionProgress();
			queueKnownCheck(tweetId);
		},
		onCountChange: (count) => {
			trackPendingCount(count);
			if (count > 0) {
				enqueueCapturedArticles();
				scheduleAutoSync();
			}
		},
	});

	try {
		const restored = await engine.restore();
		await prepareCaptureSession(engine);
		engine.start();
		mountUi();
		if (restored && engine.tweetCount() > 0) {
			enqueueCapturedArticles();
			scheduleAutoSync();
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[Bookmark Processor] Capture start failed:", msg);
		await prepareCaptureSession(engine);
		engine.start();
		mountUi();
	}
}

async function stopCapture(): Promise<void> {
	if (!engine) return;
	clearSyncTimer();
	if (knownCheckTimer) {
		clearTimeout(knownCheckTimer);
		knownCheckTimer = null;
	}
	pendingKnownCheck.clear();
	stopRetryWatcher();
	engine.stop();
	stopSidebarRetry?.();
	stopSidebarRetry = null;
	unmountSidebarUi();
	unmountSyncDock();
	uiMounted = false;
	sidebar = null;
	syncDock = null;
	engine = null;
	autoScrolling = false;
	reportCaptureScroll(false);
	syncing = false;
	syncQueued = false;
	sessionImported = 0;
	sessionSkipped = 0;
	sessionAlreadyHadIds.clear();
	showToast("Capture stopped");
}

let messageListenerRegistered = false;
let routeWatcherStarted = false;
let lastHref = location.href;

async function handleRouteChange(): Promise<void> {
	if (location.href === lastHref) return;
	lastHref = location.href;

	if (isArticlePage()) {
		if (engine) await stopCapture();
		startArticlePageCapture();
		return;
	}

	if (await isCapturePage()) {
		if (!messageListenerRegistered) {
			registerMessageListener();
			messageListenerRegistered = true;
		}
		if (!engine) await startCapture();
		return;
	}

	if (engine) await stopCapture();
}

function startRouteWatcher(): void {
	if (routeWatcherStarted) return;
	routeWatcherStarted = true;
	window.setInterval(() => {
		void handleRouteChange();
	}, 800);
}

function registerMessageListener(): void {
	if (messageListenerRegistered) return;
	messageListenerRegistered = true;
	try {
		chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
			if (message?.type === "bp-toggle-capture") {
				void (async () => {
					try {
						if (engine) await stopCapture();
						else await startCapture();
						try {
							sendResponse({ active: Boolean(engine) });
						} catch {
							/* context invalidated */
						}
					} catch {
						/* ignore */
					}
				})();
				return true;
			}
			if (message?.type === "bp-article-stats") {
				if (message.stats) applyArticleStats(message.stats);
				return false;
			}
			if (message?.type === "bp-import-progress") {
				if (message.progress) applyImportProgress(message.progress);
				return false;
			}
			if (message?.type === "bp-capture-status") {
				try {
					sendResponse({
						active: Boolean(engine),
						count: engine?.tweetCount() ?? 0,
					});
				} catch {
					/* context invalidated */
				}
				return true;
			}
			return false;
		});
	} catch {
		/* context invalidated */
	}
}

function hasExtensionContext(): boolean {
	try {
		return Boolean(chrome.runtime?.id);
	} catch {
		return false;
	}
}

async function boot(): Promise<void> {
	try {
		if (!hasExtensionContext()) {
			console.warn(
				"[Bookmark Processor] Extension context unavailable. Refresh this tab after reloading the extension.",
			);
			return;
		}
		startRouteWatcher();
		lastHref = location.href;
		if (isArticlePage()) {
			startArticlePageCapture();
			return;
		}
		if (!(await isCapturePage())) return;
		registerMessageListener();
		void startCapture();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[Bookmark Processor] Failed to start:", msg);
	}
}

void boot();
