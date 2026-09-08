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
	idbUpdate,
	IMPORT_QUEUE_STORE,
} from "./idb";

const CAPTURE_KEY = "capture";
const LEGACY_IMPORT_QUEUE_KEY = "bp-import-worker";
const IMPORT_META_KEY = "bp-import-worker-meta";
export const IMPORT_QUEUE_ALARM = "bp-import-worker-next";
const RETRY_MS = 60_000;
const IMPORT_LEASE_MS = 120_000;
/** Chrome MV3 alarms cannot reliably fire sooner than ~30s. */
const ALARM_MIN_MS = 30_000;

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
	leaseUntil?: number;
	imported: number;
	skipped: number;
	lastError?: string;
}

interface ImportWorkerMeta {
	processingId?: string;
	leaseUntil?: number;
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

export async function loadImportWorkerState(): Promise<ImportWorkerState> {
	const legacy = await idbGet<ImportWorkerState>(LEGACY_IMPORT_QUEUE_KEY);
	if (legacy) {
		for (const entry of legacy.queue ?? []) {
			await idbPutToStore(IMPORT_QUEUE_STORE, entry);
		}
		await idbSet(IMPORT_META_KEY, {
			processingId: legacy.processingId,
			leaseUntil: undefined,
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
		when: Math.max(Date.now() + ALARM_MIN_MS, when),
	});
}

/** Keep draining while the service worker is awake — no localhost throttle. */
function continueImportSoon(): void {
	setTimeout(() => {
		void processNextImport();
	}, 0);
}

async function acquireImportLease(externalId: string): Promise<boolean> {
	let acquired = false;
	const now = Date.now();
	await idbUpdate<ImportWorkerMeta>(IMPORT_META_KEY, (saved) => {
		const current = saved ?? EMPTY_META;
		if ((current.leaseUntil ?? 0) > now) return current;
		acquired = true;
		return {
			...current,
			processingId: externalId,
			leaseUntil: now + IMPORT_LEASE_MS,
			lastError: undefined,
		};
	});
	return acquired;
}

async function releaseImportLease(input?: {
	imported?: number;
	skipped?: number;
	lastError?: string;
}): Promise<void> {
	await idbUpdate<ImportWorkerMeta>(IMPORT_META_KEY, (saved) => {
		const current = saved ?? EMPTY_META;
		return {
			...current,
			processingId: undefined,
			leaseUntil: undefined,
			imported: current.imported + (input?.imported ?? 0),
			skipped: current.skipped + (input?.skipped ?? 0),
			lastError: input?.lastError,
		};
	});
}

/** Process at most one persisted tweet. Each call is one MV3 worker event. */
export async function processNextImport(): Promise<ImportWorkerState> {
	let state = await loadImportWorkerState();
	const entry = state.queue[0];
	if (!entry) {
		await chrome.alarms.clear(IMPORT_QUEUE_ALARM);
		return state;
	}
	if (entry.nextAt && entry.nextAt > Date.now()) {
		await scheduleNext(entry.nextAt);
		return state;
	}
	if (!(await acquireImportLease(entry.externalId))) {
		state = await loadImportWorkerState();
		await scheduleNext(state.leaseUntil ?? Date.now() + RETRY_MS);
		return state;
	}

	state = await loadImportWorkerState();
	await broadcast(progressOf(state));

	try {
		const result = await uploadPayload(entry.payload, entry.serverUrl);
		const accounted = result.imported + result.skipped;
		if (accounted !== 1) {
			throw new Error("Server did not account for the queued tweet");
		}
		await idbDeleteFromStore(IMPORT_QUEUE_STORE, entry.externalId);
		await releaseImportLease({
			imported: result.imported,
			skipped: result.skipped,
		});
		await removeFromCapture(entry.externalId);
		state = await loadImportWorkerState();
		await broadcast(
			progressOf(state, {
				completedIds: [entry.externalId],
				importedDelta: result.imported,
				skippedDelta: result.skipped,
				libraryTotal: result.total,
			}),
		);
		if (state.queue.length > 0) {
			// Durable wake-up only — X rate limits live in article hydration, not here.
			await scheduleNext(Date.now() + RETRY_MS);
			continueImportSoon();
		} else {
			await chrome.alarms.clear(IMPORT_QUEUE_ALARM);
		}
		return state;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Import worker failed";
		entry.attempts += 1;
		entry.lastError = message;
		entry.nextAt = Date.now() + RETRY_MS;
		await idbPutToStore(IMPORT_QUEUE_STORE, entry);
		await releaseImportLease({ lastError: message });
		state = await loadImportWorkerState();
		await broadcast(progressOf(state));
		await scheduleNext(entry.nextAt);
		return state;
	}
}

export function importWorkerProgress(
	state: ImportWorkerState,
): ImportWorkerProgress {
	return progressOf(state);
}
