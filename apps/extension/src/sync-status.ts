import type {
	ExtensionStatusReport,
	SyncRevocation,
	SyncStatusResponse,
} from "@repo/import";
import { markArticleRemoved } from "@repo/import";
import type { CaptureState } from "@repo/import/capture/engine";
import { idbGet, idbSet } from "./idb";
import {
	loadArticleQueue,
	loadHydrationState,
	updateArticleQueue,
} from "./article-queue";

const CAPTURE_KEY = "capture";

export async function buildExtensionStatusReport(input: {
	articles: ExtensionStatusReport["articles"];
	articleQueue?: ExtensionStatusReport["articleQueue"];
	importWorker?: ExtensionStatusReport["importWorker"];
	captureScrollActive?: boolean;
	lastError?: string;
}): Promise<ExtensionStatusReport> {
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	const hydration = await loadHydrationState();

	return {
		capturedUnsynced: Object.keys(capture?.tweets ?? {}).length,
		pendingUpload: (input.importWorker?.pending ?? 0) > 0,
		pendingUploadCount: input.importWorker?.pending ?? 0,
		articles: input.articles,
		articleQueue: input.articleQueue,
		importWorker: input.importWorker,
		captureScrollActive: input.captureScrollActive,
		rateLimitedUntil: hydration.rateLimitedUntil,
		lastError: input.lastError,
		reportedAt: new Date().toISOString(),
	};
}

export async function postSyncStatus(
	serverUrl: string,
	report: ExtensionStatusReport,
	ackRevocationIds: string[] = [],
): Promise<SyncStatusResponse | null> {
	const base = serverUrl.replace(/\/$/, "");
	const res = await fetch(`${base}/api/import/status`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ report, ackRevocationIds }),
	});
	if (!res.ok) return null;
	return (await res.json()) as SyncStatusResponse;
}

export async function applySyncRevocations(
	revocations: SyncRevocation[],
): Promise<string[]> {
	if (revocations.length === 0) return [];

	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	if (capture?.tweets) {
		for (const rev of revocations) {
			delete capture.tweets[rev.externalId];
			if (rev.tweetId) delete capture.tweets[rev.tweetId];
		}
		await idbSet(CAPTURE_KEY, capture);
	}

	await updateArticleQueue((queue) => {
		let next = queue;
		for (const rev of revocations) {
			if (rev.articleId) {
				next = markArticleRemoved(next, rev.articleId);
			}
		}
		return next;
	});

	return revocations.map((rev) => rev.id);
}
