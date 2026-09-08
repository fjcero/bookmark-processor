import type {
	ExtensionStatusReport,
	SyncRevocation,
	SyncStatusResponse,
} from "@repo/import";
import {
	toPersistedCaptureState,
	type CaptureState,
} from "@repo/import/capture/engine";
import { CAPTURE_KEY } from "./constants";
import { idbDelete, idbGet, idbSet } from "./idb";

export async function buildExtensionStatusReport(input: {
	articles: ExtensionStatusReport["articles"];
	articleQueue?: ExtensionStatusReport["articleQueue"];
	importWorker?: ExtensionStatusReport["importWorker"];
	captureScrollActive?: boolean;
	rateLimitedUntil?: number;
	lastError?: string;
}): Promise<ExtensionStatusReport> {
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);

	return {
		capturedUnsynced: Object.keys(capture?.tweets ?? {}).length,
		pendingUpload: (input.importWorker?.pending ?? 0) > 0,
		pendingUploadCount: input.importWorker?.pending ?? 0,
		articles: input.articles,
		articleQueue: input.articleQueue,
		importWorker: input.importWorker,
		captureScrollActive: input.captureScrollActive,
		rateLimitedUntil: input.rateLimitedUntil,
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

export async function applyCaptureRevocations(
	revocations: SyncRevocation[],
): Promise<string[]> {
	if (revocations.length === 0) return [];

	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	if (capture?.tweets) {
		for (const rev of revocations) {
			delete capture.tweets[rev.externalId];
			if (rev.tweetId) delete capture.tweets[rev.tweetId];
		}
		const slim = toPersistedCaptureState(capture);
		if (Object.keys(slim.tweets).length === 0 && !(slim.responses?.length)) {
			await idbDelete(CAPTURE_KEY);
		} else {
			await idbSet(CAPTURE_KEY, slim);
		}
	}

	return revocations.map((rev) => rev.id);
}
