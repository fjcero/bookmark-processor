import { articleQueueStats } from "@repo/import";
import { broadcastToTabs } from "../core/broadcast";
import {
	SYNC_STATUS_ERROR_KEY,
	SYNC_STATUS_PUSH_ALARM,
} from "../core/constants";
import { idbSet } from "../core/idb";
import {
	importWorkerProgress,
	loadImportWorkerState,
} from "../core/import-worker";
import { allTabUrlPatterns, getPlatforms } from "../core/platform";
import { loadSettings } from "../core/storage";
import {
	applyCaptureRevocations,
	buildExtensionStatusReport,
	postSyncStatus,
} from "../core/sync-status";

export async function syncWithServer(lastError?: string): Promise<void> {
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return;

	const importWorker = await loadImportWorkerState();
	const slices = await Promise.all(
		getPlatforms().map((platform) => platform.buildStatusSlice()),
	);
	const articles = slices.reduce(
		(acc, slice) => ({
			pending: acc.pending + slice.articles.pending,
			fetching: acc.fetching + slice.articles.fetching,
			ok: acc.ok + slice.articles.ok,
			failed: acc.failed + slice.articles.failed,
			total: acc.total + slice.articles.total,
		}),
		articleQueueStats([]),
	);
	const articleQueue = slices.flatMap((slice) => slice.articleQueue ?? []);
	const captureScrollActive = slices.some((slice) => slice.captureScrollActive);
	const rateLimitedUntil = slices.reduce<number | undefined>(
		(latest, slice) => {
			if (slice.rateLimitedUntil == null) return latest;
			if (latest == null) return slice.rateLimitedUntil;
			return Math.max(latest, slice.rateLimitedUntil);
		},
		undefined,
	);

	const report = await buildExtensionStatusReport({
		articles,
		articleQueue: articleQueue.slice(0, 100),
		importWorker: importWorkerProgress(importWorker),
		captureScrollActive,
		rateLimitedUntil,
		lastError,
	});

	const response = await postSyncStatus(settings.serverUrl, report);
	if (!response) return;
	await broadcastToTabs(allTabUrlPatterns(), {
		type: "bp-library-article-count",
		count: response.library.articlesNeedingBody,
	});

	const acked = await applyCaptureRevocations(response.revocations);
	await Promise.all(
		getPlatforms().map((platform) =>
			platform.applyRevocations(response.revocations),
		),
	);
	if (acked.length > 0) {
		await postSyncStatus(settings.serverUrl, report, acked);
	}
}

export function scheduleSyncStatusPush(lastError?: string): void {
	void (async () => {
		if (lastError) await idbSet(SYNC_STATUS_ERROR_KEY, lastError);
		const existing = await chrome.alarms.get(SYNC_STATUS_PUSH_ALARM);
		if (existing) return;
		await chrome.alarms.create(SYNC_STATUS_PUSH_ALARM, {
			when: Date.now() + 30_000,
		});
	})();
}
