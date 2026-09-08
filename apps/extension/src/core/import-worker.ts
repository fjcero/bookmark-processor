import {
	uploadPayload,
	type CaptureState,
	type ExportPayload,
} from "@repo/import/capture/engine";
import type { ImportWorkerProgress } from "@repo/import";
import { broadcastToTabs } from "./broadcast";
import { CAPTURE_KEY } from "./constants";
import {
	idbDelete,
	idbDeleteManyFromStore,
	idbGet,
	idbGetAllFromStore,
	idbPutManyToStore,
	idbPutToStore,
	idbSet,
	idbUpdate,
	IMPORT_QUEUE_STORE,
} from "./idb";
import { allTabUrlPatterns } from "./platform";
import { loadSettings } from "./storage";

const LEGACY_IMPORT_QUEUE_KEY = "bp-import-worker";
const IMPORT_META_KEY = "bp-import-worker-meta";
export const IMPORT_QUEUE_ALARM = "bp-import-worker-next";
const RETRY_MS = 60_000;
const IMPORT_LEASE_MS = 120_000;
/** Chrome MV3 alarms cannot reliably fire sooner than ~30s. */
const ALARM_MIN_MS = 30_000;
const IMPORT_BATCH_SIZE = 50;

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

const EMPTY_META: ImportWorkerMeta = {
	imported: 0,
	skipped: 0,
};

function isPendingEntry(entry: ImportWorkerEntry): boolean {
	return Boolean(entry?.payload?.tweets && entry.externalId);
}

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

	const [raw, savedMeta] = await Promise.all([
		idbGetAllFromStore<ImportWorkerEntry>(IMPORT_QUEUE_STORE),
		idbGet<ImportWorkerMeta>(IMPORT_META_KEY),
	]);
	const queue = raw.filter(isPendingEntry);
	queue.sort((a, b) => (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0));
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
		responses: [],
	};
}

function batchPayload(entries: ImportWorkerEntry[]): ExportPayload {
	const first = entries[0]!;
	const tweets: Record<string, unknown> = {};
	for (const entry of entries) {
		const tweet = entry.payload.tweets[entry.externalId];
		if (tweet != null) tweets[entry.externalId] = tweet;
	}
	return {
		...first.payload,
		stats: { tweetCount: Object.keys(tweets).length, responseCount: 0 },
		tweets,
		responses: [],
	};
}

function readyEntries(
	queue: ImportWorkerEntry[],
	now = Date.now(),
): ImportWorkerEntry[] {
	return queue.filter((entry) => !entry.nextAt || entry.nextAt <= now);
}

async function resolveServerUrl(preferred?: string): Promise<string> {
	if (preferred && preferred.trim()) return preferred.trim();
	const settings = await loadSettings();
	if (settings.serverUrl?.trim()) return settings.serverUrl.trim();
	throw new Error("Server URL is not configured");
}

export async function enqueueImportPayload(
	payload: ExportPayload,
	serverUrl: string,
): Promise<ImportWorkerState> {
	const resolvedUrl = await resolveServerUrl(serverUrl);
	const state = await loadImportWorkerState();
	const queued = new Set(state.queue.map((entry) => entry.externalId));
	const added: ImportWorkerEntry[] = [];
	for (const [externalId, tweet] of Object.entries(payload.tweets)) {
		if (queued.has(externalId)) continue;
		const entry: ImportWorkerEntry = {
			externalId,
			payload: singleTweetPayload(payload, externalId, tweet),
			serverUrl: resolvedUrl,
			attempts: 0,
			enqueuedAt: Date.now(),
		};
		added.push(entry);
		state.queue.push(entry);
		queued.add(externalId);
	}
	await idbPutManyToStore(IMPORT_QUEUE_STORE, added);
	if (state.queue.length > 0) {
		await scheduleNext(Date.now() + RETRY_MS);
	}
	return state;
}

async function removeFromCapture(externalIds: string[]): Promise<void> {
	if (externalIds.length === 0) return;
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	if (!capture?.tweets) return;
	let changed = false;
	for (const externalId of externalIds) {
		if (!(externalId in capture.tweets)) continue;
		delete capture.tweets[externalId];
		changed = true;
	}
	if (changed) await idbSet(CAPTURE_KEY, capture);
}

function notifyProgress(progress: ImportWorkerProgress): void {
	void broadcast(progress);
}

async function broadcast(progress: ImportWorkerProgress): Promise<void> {
	await broadcastToTabs(allTabUrlPatterns(), {
		type: "bp-import-progress",
		progress,
	});
}

function progressOf(
	state: ImportWorkerState,
	extra: Partial<ImportWorkerProgress> = {},
	processingIds?: Set<string>,
): ImportWorkerProgress {
	const processing =
		processingIds ??
		(state.processingId ? new Set([state.processingId]) : new Set<string>());
	return {
		pending: state.queue.length,
		processingId: state.processingId,
		imported: state.imported,
		skipped: state.skipped,
		items: state.queue.slice(0, 100).map((entry) => ({
			externalId: entry.externalId,
			status: processing.has(entry.externalId) ? "processing" : "pending",
			attempts: entry.attempts ?? 0,
			enqueuedAt: entry.enqueuedAt,
			nextAt: entry.nextAt,
			lastError: entry.lastError,
		})),
		lastError: state.lastError,
		...extra,
	};
}

async function scheduleNext(when: number): Promise<void> {
	const needed = Math.max(Date.now() + ALARM_MIN_MS, when);
	const existing = await chrome.alarms.get(IMPORT_QUEUE_ALARM);
	if (existing?.scheduledTime != null && existing.scheduledTime <= needed) {
		return;
	}
	await chrome.alarms.create(IMPORT_QUEUE_ALARM, { when: needed });
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

async function processOneBatch(): Promise<{
	progress: ImportWorkerProgress;
	didWork: boolean;
}> {
	let state = await loadImportWorkerState();
	const batch = readyEntries(state.queue).slice(0, IMPORT_BATCH_SIZE);
	if (batch.length === 0) {
		if (state.queue.length === 0) {
			await chrome.alarms.clear(IMPORT_QUEUE_ALARM);
			return { progress: progressOf(state), didWork: false };
		}
		const nextAt = Math.min(
			...state.queue.map((entry) => entry.nextAt ?? Date.now()),
		);
		await scheduleNext(nextAt);
		return { progress: progressOf(state), didWork: false };
	}

	const head = batch[0]!;
	if (!(await acquireImportLease(head.externalId))) {
		state = await loadImportWorkerState();
		await scheduleNext(state.leaseUntil ?? Date.now() + RETRY_MS);
		return { progress: progressOf(state), didWork: false };
	}

	state = await loadImportWorkerState();
	const processingIds = new Set(batch.map((entry) => entry.externalId));
	notifyProgress(progressOf(state, {}, processingIds));

	try {
		const serverUrl = await resolveServerUrl(head.serverUrl);
		const result = await uploadPayload(batchPayload(batch), serverUrl);
		const accounted = result.imported + result.skipped;
		if (accounted === 0) {
			throw new Error("Server did not account for the queued tweets");
		}
		if (accounted !== batch.length) {
			throw new Error(
				`Server accounted for ${accounted} of ${batch.length} queued tweets`,
			);
		}

		await idbDeleteManyFromStore(
			IMPORT_QUEUE_STORE,
			batch.map((entry) => entry.externalId),
		);
		await releaseImportLease({
			imported: result.imported,
			skipped: result.skipped,
		});
		await removeFromCapture(batch.map((entry) => entry.externalId));
		state = await loadImportWorkerState();
		const progress = progressOf(state, {
			completedIds: batch.map((entry) => entry.externalId),
			importedDelta: result.imported,
			skippedDelta: result.skipped,
			libraryTotal: result.total,
		});
		notifyProgress(progress);
		if (state.queue.length > 0) {
			await scheduleNext(Date.now() + RETRY_MS);
		} else {
			await chrome.alarms.clear(IMPORT_QUEUE_ALARM);
		}
		return { progress, didWork: true };
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Import worker failed";
		const nextAt = Date.now() + RETRY_MS;
		await idbPutManyToStore(
			IMPORT_QUEUE_STORE,
			batch.map((entry) => ({
				...entry,
				serverUrl: entry.serverUrl || head.serverUrl,
				attempts: (entry.attempts ?? 0) + 1,
				lastError: message,
				nextAt,
			})),
		);
		await releaseImportLease({ lastError: message });
		state = await loadImportWorkerState();
		const progress = progressOf(state);
		notifyProgress(progress);
		await scheduleNext(nextAt);
		return { progress, didWork: false };
	}
}

/**
 * Drain ready batches of up to 50 tweets in the service worker.
 * Uses chrome.alarms for wakeups — no setTimeout.
 */
export async function processNextImport(): Promise<ImportWorkerProgress> {
	let progress = progressOf(await loadImportWorkerState());
	for (;;) {
		const step = await processOneBatch();
		progress = step.progress;
		if (!step.didWork) break;
		if (readyEntries((await loadImportWorkerState()).queue).length === 0) {
			break;
		}
	}
	return progress;
}

export function importWorkerProgress(
	state: ImportWorkerState,
): ImportWorkerProgress {
	return progressOf(state);
}
