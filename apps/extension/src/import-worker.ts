import {
	uploadPayload,
	type CaptureState,
	type ExportPayload,
} from "@repo/import/capture/engine";
import {
	idbDelete,
	idbDeleteFromStore,
	idbGet,
	idbGetAllFromStore,
	idbPutToStore,
	idbSet,
	IMPORT_QUEUE_STORE,
} from "./idb";

const CAPTURE_KEY = "capture";
const LEGACY_IMPORT_QUEUE_KEY = "bp-import-worker";
const IMPORT_META_KEY = "bp-import-worker-meta";
export const IMPORT_QUEUE_ALARM = "bp-import-worker-next";
const RETRY_MS = 60_000;

export interface ImportWorkerEntry {
	externalId: string;
	payload: ExportPayload;
	serverUrl: string;
	attempts: number;
	enqueuedAt: number;
	nextAt?: number;
	lastError?: string;
}

export interface ImportWorkerState {
	queue: ImportWorkerEntry[];
	processingId?: string;
	imported: number;
	skipped: number;
	lastError?: string;
}

interface ImportWorkerMeta {
	processingId?: string;
	imported: number;
	skipped: number;
	lastError?: string;
}

export interface ImportWorkerProgress {
	pending: number;
	processingId?: string;
	imported: number;
	skipped: number;
	items?: Array<{
		externalId: string;
		status: "pending" | "processing";
		attempts: number;
		enqueuedAt: number;
		nextAt?: number;
		lastError?: string;
	}>;
	completedIds?: string[];
	importedDelta?: number;
	skippedDelta?: number;
	libraryTotal?: number | null;
	lastError?: string;
}

const EMPTY_META: ImportWorkerMeta = {
	imported: 0,
	skipped: 0,
};

let draining: Promise<ImportWorkerState> | null = null;
let progressListener: ((progress: ImportWorkerProgress) => void) | null = null;

export function setImportWorkerProgressListener(
	listener: (progress: ImportWorkerProgress) => void,
): void {
	progressListener = listener;
}

export async function loadImportWorkerState(): Promise<ImportWorkerState> {
	const legacy = await idbGet<ImportWorkerState>(LEGACY_IMPORT_QUEUE_KEY);
	if (legacy) {
		for (const entry of legacy.queue ?? []) {
			await idbPutToStore(IMPORT_QUEUE_STORE, entry);
		}
		await idbSet(IMPORT_META_KEY, {
			processingId: legacy.processingId,
			imported: legacy.imported ?? 0,
			skipped: legacy.skipped ?? 0,
			lastError: legacy.lastError,
		} satisfies ImportWorkerMeta);
		await idbDelete(LEGACY_IMPORT_QUEUE_KEY);
	}

	const [queue, savedMeta] = await Promise.all([
		idbGetAllFromStore<ImportWorkerEntry>(IMPORT_QUEUE_STORE),
		idbGet<ImportWorkerMeta>(IMPORT_META_KEY),
	]);
	queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	const meta = savedMeta ?? EMPTY_META;
	return { queue, ...meta };
}

async function saveImportWorkerState(state: ImportWorkerState): Promise<void> {
	await idbSet(IMPORT_META_KEY, {
		processingId: state.processingId,
		imported: state.imported,
		skipped: state.skipped,
		lastError: state.lastError,
	} satisfies ImportWorkerMeta);
}

function singleTweetPayload(
	payload: ExportPayload,
	externalId: string,
	tweet: unknown,
): ExportPayload {
	return {
		...payload,
		stats: { tweetCount: 1, responseCount: 0 },
		tweets: { [externalId]: tweet },
		// Capture responses can contain an entire page and must not be duplicated
		// for every queued tweet. Rich article data is already stamped on the tweet.
		responses: [],
	};
}

export async function enqueueImportPayload(
	payload: ExportPayload,
	serverUrl: string,
): Promise<ImportWorkerState> {
	const state = await loadImportWorkerState();
	const queued = new Set(state.queue.map((entry) => entry.externalId));
	for (const [externalId, tweet] of Object.entries(payload.tweets)) {
		if (queued.has(externalId)) continue;
		const entry: ImportWorkerEntry = {
			externalId,
			payload: singleTweetPayload(payload, externalId, tweet),
			serverUrl,
			attempts: 0,
			enqueuedAt: Date.now(),
		};
		await idbPutToStore(IMPORT_QUEUE_STORE, entry);
		state.queue.push(entry);
		queued.add(externalId);
	}
	await saveImportWorkerState(state);
	if (state.queue.length > 0) {
		// Durable wake-up in case Chrome suspends the service worker mid-drain.
		await scheduleNext(Date.now() + RETRY_MS);
	}
	return state;
}

async function removeFromCapture(externalId: string): Promise<void> {
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	if (!capture?.tweets?.[externalId]) return;
	delete capture.tweets[externalId];
	await idbSet(CAPTURE_KEY, capture);
}

async function broadcast(progress: ImportWorkerProgress): Promise<void> {
	progressListener?.(progress);
	const tabs = await chrome.tabs.query({
		url: ["https://x.com/*", "https://twitter.com/*"],
	});
	await Promise.all(
		tabs
			.filter((tab) => tab.id != null)
			.map((tab) =>
				chrome.tabs
					.sendMessage(tab.id!, { type: "bp-import-progress", progress })
					.catch(() => {
						/* no capture content script */
					}),
			),
	);
}

function progressOf(
	state: ImportWorkerState,
	extra: Partial<ImportWorkerProgress> = {},
): ImportWorkerProgress {
	return {
		pending: state.queue.length,
		processingId: state.processingId,
		imported: state.imported,
		skipped: state.skipped,
		items: state.queue.slice(0, 100).map((entry) => ({
			externalId: entry.externalId,
			status:
				entry.externalId === state.processingId ? "processing" : "pending",
			attempts: entry.attempts,
			enqueuedAt: entry.enqueuedAt,
			nextAt: entry.nextAt,
			lastError: entry.lastError,
		})),
		lastError: state.lastError,
		...extra,
	};
}

async function scheduleNext(when: number): Promise<void> {
	await chrome.alarms.create(IMPORT_QUEUE_ALARM, {
		when: Math.max(Date.now() + 1000, when),
	});
}

async function drain(): Promise<ImportWorkerState> {
	let state = await loadImportWorkerState();
	while (state.queue.length > 0) {
		const entry = state.queue[0]!;
		if (entry.nextAt && entry.nextAt > Date.now()) {
			await scheduleNext(entry.nextAt);
			break;
		}

		state.processingId = entry.externalId;
		state.lastError = undefined;
		await saveImportWorkerState(state);
		await broadcast(progressOf(state));

		try {
			const result = await uploadPayload(entry.payload, entry.serverUrl);
			const accounted = result.imported + result.skipped;
			if (accounted !== 1) {
				throw new Error("Server did not account for the queued tweet");
			}

			state.queue.shift();
			await idbDeleteFromStore(IMPORT_QUEUE_STORE, entry.externalId);
			state.processingId = undefined;
			state.imported += result.imported;
			state.skipped += result.skipped;
			state.lastError = undefined;
			await saveImportWorkerState(state);
			await removeFromCapture(entry.externalId);
			await broadcast(
				progressOf(state, {
					completedIds: [entry.externalId],
					importedDelta: result.imported,
					skippedDelta: result.skipped,
					libraryTotal: result.total,
				}),
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Import worker failed";
			entry.attempts += 1;
			entry.lastError = message;
			entry.nextAt = Date.now() + RETRY_MS;
			await idbPutToStore(IMPORT_QUEUE_STORE, entry);
			state.processingId = undefined;
			state.lastError = message;
			await saveImportWorkerState(state);
			await broadcast(progressOf(state));
			await scheduleNext(entry.nextAt);
			break;
		}
	}

	if (state.queue.length === 0) {
		state.processingId = undefined;
		await saveImportWorkerState(state);
		await chrome.alarms.clear(IMPORT_QUEUE_ALARM);
	}
	return state;
}

export function drainImportQueue(): Promise<ImportWorkerState> {
	if (draining) return draining;
	draining = drain().finally(() => {
		draining = null;
	});
	return draining;
}

export function importWorkerProgress(
	state: ImportWorkerState,
): ImportWorkerProgress {
	return progressOf(state);
}
