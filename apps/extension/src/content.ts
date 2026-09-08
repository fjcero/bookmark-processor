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
} from "@repo/import";
import { clearCaptureQueue } from "@repo/import/capture/hooks-events";
import {
	createBackgroundStorageAdapter,
	enqueueImportsInBackground,
	fetchTotalInBackground,
} from "./core/background-client";
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
	updateSidebarCount,
	updateServerTotal,
} from "./sidebar-ui";
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

function isCapturePage(): boolean {
	if (
		!location.hostname.includes("twitter.com") &&
		!location.hostname.includes("x.com")
	) {
		return false;
	}
	return (
		location.pathname.includes("/bookmarks") ||
		location.pathname.includes("/likes") ||
		location.pathname.includes("/history")
	);
}

let engine: CaptureEngine | null = null;
let sidebar: SidebarUiRefs | null = null;
let autoScrolling = false;
let uiMounted = false;
let stopSidebarRetry: (() => void) | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let syncQueued = false;
let retryObserver: MutationObserver | null = null;
let sessionImported = 0;
let sessionSkipped = 0;
let libraryArticlesMissing: number | null = null;

function reportCaptureScroll(active: boolean): void {
	try {
		void chrome.runtime.sendMessage({ type: "bp-capture-scroll", active });
	} catch {
		/* background unavailable */
	}
}

function applyArticleStats(stats: {
	pending: number;
	fetching: number;
	ok: number;
	failed: number;
	total: number;
}): void {
	if (!sidebar) return;
	setArticleStatus(sidebar, stats, libraryArticlesMissing);
}

function renderSessionProgress(): void {
	if (!sidebar) return;
	const pending = engine?.tweetCount() ?? 0;
	const captured = engine?.observedCount() ?? 0;
	const synced = sessionImported + sessionSkipped;
	updateSidebarCount(sidebar, `${captured} / ${synced}`, "Captured / synced");
	setSyncStatus(
		sidebar,
		`${sessionImported} new · ${sessionSkipped} skipped · ${pending} pending`,
	);
}

function trackPendingCount(count: number): void {
	renderSessionProgress();
}

function applyImportProgress(progress: ImportWorkerProgress): void {
	if (progress.completedIds?.length && engine) {
		engine.removeSynced(progress.completedIds);
		clearCaptureQueue();
	}
	sessionImported += progress.importedDelta ?? 0;
	sessionSkipped += progress.skippedDelta ?? 0;
	if (sidebar && progress.libraryTotal != null) {
		updateServerTotal(sidebar, progress.libraryTotal);
	}
	renderSessionProgress();
	if (!sidebar) return;

	if (progress.lastError) {
		setSyncRetryVisible(sidebar, true);
		setSyncStatus(sidebar, "Background import paused — retrying");
		return;
	}
	setSyncRetryVisible(sidebar, false);
}

function enqueueCapturedArticles(): void {
	if (!engine) return;
	const payload = engine.buildPayload();
	const articles: Array<{ tweetId: string; articleId: string; url: string }> =
		[];
	for (const [tweetId, tweet] of Object.entries(payload.tweets)) {
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

async function refreshServerTotal(): Promise<void> {
	if (!sidebar) return;
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) {
		updateServerTotal(sidebar, null);
		return;
	}
	try {
		const total = await fetchTotalInBackground(settings.serverUrl);
		if (sidebar) updateServerTotal(sidebar, total);
	} catch {
		if (sidebar) updateServerTotal(sidebar, null);
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
	if (!engine || !sidebar) return;
	let workerPaused = false;
	if (syncing) {
		syncQueued = true;
		return;
	}

	const pendingPayload = engine.buildPayload();
	const pendingCount = Object.keys(pendingPayload.tweets).length;
	if (pendingCount === 0) {
		if (opts.manual) showToast("Nothing to sync yet — scroll first");
		return;
	}

	const settings = await loadSettings();

	if (settings.mode === "download") {
		downloadPayload(pendingPayload);
		showToast(`Downloaded ${pendingCount} ${engine.label}`);
		clearCaptureQueue();
		await engine.reset();
		autoScrolling = false;
		renderSessionProgress();
		setAutoScrollUi(sidebar, "idle");
		return;
	}

	if (!settings.serverUrl) {
		if (opts.manual) showToast("Set server URL in extension popup");
		return;
	}

	clearSyncTimer();
	syncing = true;
	setSyncRetryVisible(sidebar, false);

	try {
		const progress = await enqueueImportsInBackground(
			pendingPayload,
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
		setSyncStatus(sidebar, "Sync failed — click Retry or wait");
		setSyncRetryVisible(sidebar, true);
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
	if (!engine || !sidebar) return;
	if (autoScrolling) {
		autoScrolling = false;
		stopRetryWatcher();
		setAutoScrollUi(sidebar, "idle");
		reportCaptureScroll(false);
		return;
	}
	autoScrolling = true;
	reportCaptureScroll(true);
	startRetryWatcher();
	setAutoScrollUi(sidebar, "running");
	void (async () => {
		const settings = await loadSettings();
		if (!engine || !sidebar) return;
		await runAutoScroll(
			engine,
			(_count, done) => {
				if (!sidebar || !engine) return;
				renderSessionProgress();
				if (done) {
					autoScrolling = false;
					reportCaptureScroll(false);
					stopRetryWatcher();
					setAutoScrollUi(sidebar, "done", engine.observedCount());
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

function mountUi(): void {
	if (uiMounted || !engine) return;

	const label = engine.label;
	const count = engine.tweetCount();

	stopSidebarRetry = mountSidebarUiWithRetry(
		{
			label,
			count,
			onSyncRetry: () => void performSync({ manual: true }),
			onAutoScroll: handleAutoScroll,
		},
		(refs) => {
			sidebar = refs;
			uiMounted = true;
			renderSessionProgress();
			void refreshServerTotal();
			void refreshArticleStats();
		},
	);
}

async function startCapture(): Promise<void> {
	if (!isCapturePage()) return;
	if (engine) {
		showToast("Capture already active");
		return;
	}
	engine = new CaptureEngine({
		storage: createBackgroundStorageAdapter(),
		storeResponses: false,
		onTweetObserved: () => {
			renderSessionProgress();
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
		engine.start();
		mountUi();
		if (restored && engine.tweetCount() > 0) {
			enqueueCapturedArticles();
			scheduleAutoSync();
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[Bookmark Processor] Capture start failed:", msg);
		engine.start();
		mountUi();
	}
}

async function stopCapture(): Promise<void> {
	if (!engine) return;
	clearSyncTimer();
	stopRetryWatcher();
	engine.stop();
	stopSidebarRetry?.();
	stopSidebarRetry = null;
	unmountSidebarUi();
	uiMounted = false;
	sidebar = null;
	engine = null;
	autoScrolling = false;
	reportCaptureScroll(false);
	syncing = false;
	syncQueued = false;
	sessionImported = 0;
	sessionSkipped = 0;
	libraryArticlesMissing = null;
	showToast("Capture stopped");
}

function registerMessageListener(): void {
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
			if (message?.type === "bp-library-article-count") {
				libraryArticlesMissing = Number(message.count);
				void refreshArticleStats();
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

function boot(): void {
	try {
		if (!hasExtensionContext()) {
			console.warn(
				"[Bookmark Processor] Extension context unavailable — refresh this tab after reloading the extension.",
			);
			return;
		}
		if (isArticlePage()) {
			startArticlePageCapture();
			return;
		}
		if (!isCapturePage()) return;
		registerMessageListener();
		void startCapture();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("[Bookmark Processor] Failed to start:", msg);
	}
}

boot();
