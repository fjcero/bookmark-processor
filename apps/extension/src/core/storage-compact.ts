import {
	toPersistedCaptureState,
	type CaptureState,
} from "@repo/import/capture/engine";
import { CAPTURE_KEY, PENDING_UPLOAD_KEY } from "./constants";
import { idbDelete, idbGet, idbSet } from "./idb";
import {
	deleteInvalidImportQueueRows,
	getImportWorkStatus,
} from "./import-worker";
import {
	flushLibraryCacheWrites,
	getLibraryCacheMeta,
	libraryCacheNeedsRebuild,
	maybeRebuildLibraryCache,
} from "./library-cache";
import { loadSettings } from "./storage";
import {
	compactArticleQueue,
	loadHydrationState,
} from "../platforms/x/article-queue";
import {
	recoverInterruptedArticles,
	reconcileArticleQueueWithServer,
} from "../platforms/x/article-hydration";
import {
	ARTICLE_TABS_KEY,
	ARTICLE_TEMPLATE_KEY,
	ARTICLE_WORKER_TAB_KEY,
	CAPTURE_SCROLL_KEY,
} from "../platforms/x/constants";

const LEGACY_IMPORT_QUEUE_KEY = "bp-import-worker";

export interface CompactOptions {
	aggressive?: boolean;
}

export interface CompactResult {
	skippedInFlight: boolean;
	clearedCapture: boolean;
	strippedCapture: boolean;
	invalidImportRows: number;
	rebuiltLibraryCache: boolean;
	keysCleared: string[];
}

async function storageEstimate(): Promise<string> {
	try {
		const estimate = await navigator.storage?.estimate?.();
		if (!estimate) return "unknown";
		return `usage=${estimate.usage ?? 0} quota=${estimate.quota ?? 0}`;
	} catch {
		return "unknown";
	}
}

async function slimCapture(): Promise<{
	stripped: boolean;
	cleared: boolean;
}> {
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	if (!capture) return { stripped: false, cleared: false };
	const slim = toPersistedCaptureState(capture);
	const tweetCount = Object.keys(slim.tweets ?? {}).length;
	if (tweetCount === 0 && !(slim.responses?.length)) {
		await idbDelete(CAPTURE_KEY);
		return { stripped: true, cleared: true };
	}
	const changed =
		(capture.synced?.length ?? 0) > 0 ||
		(capture.seen?.length ?? 0) !== (slim.seen?.length ?? 0);
	if (changed) await idbSet(CAPTURE_KEY, slim);
	return { stripped: changed, cleared: false };
}

async function articleWorkerBusy(): Promise<boolean> {
	const state = await loadHydrationState();
	return (
		Boolean(state.processingArticleId) && (state.leaseUntil ?? 0) > Date.now()
	);
}

async function clearEphemeralKeys(keys: string[]): Promise<string[]> {
	const cleared: string[] = [];
	for (const key of keys) {
		const existing = await idbGet(key);
		if (existing == null) continue;
		await idbDelete(key);
		cleared.push(key);
	}
	return cleared;
}

export async function compactExtensionStorage(
	opts: CompactOptions = {},
): Promise<CompactResult> {
	const aggressive = Boolean(opts.aggressive);
	const before = await storageEstimate();
	await flushLibraryCacheWrites();

	const importStatus = await getImportWorkStatus();
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	const tweetIds = Object.keys(capture?.tweets ?? {});
	const tweetsOnlyQueued =
		tweetIds.length === 0 ||
		tweetIds.every((id) => importStatus.queuedIds.has(id));
	const articleBusy = await articleWorkerBusy();
	const safe =
		importStatus.pendingCount === 0 &&
		!importStatus.leaseActive &&
		tweetsOnlyQueued &&
		!articleBusy;

	const captureResult = await slimCapture();
	const invalidImportRows = await deleteInvalidImportQueueRows();
	await compactArticleQueue();

	const result: CompactResult = {
		skippedInFlight: !safe && !aggressive,
		clearedCapture: captureResult.cleared,
		strippedCapture: captureResult.stripped,
		invalidImportRows,
		rebuiltLibraryCache: false,
		keysCleared: [],
	};

	if (safe || aggressive) {
		try {
			await recoverInterruptedArticles();
		} catch {
			/* tabs API unavailable */
		}
		const ephemeral = [CAPTURE_SCROLL_KEY, PENDING_UPLOAD_KEY, LEGACY_IMPORT_QUEUE_KEY];
		if (!articleBusy || aggressive) {
			ephemeral.push(ARTICLE_TEMPLATE_KEY);
			if (aggressive) {
				ephemeral.push(ARTICLE_TABS_KEY, ARTICLE_WORKER_TAB_KEY);
			}
		}
		result.keysCleared = await clearEphemeralKeys(ephemeral);

		const settings = await loadSettings();
		if (settings.mode === "api" && settings.serverUrl) {
			try {
				await reconcileArticleQueueWithServer(settings.serverUrl);
			} catch {
				/* server unreachable */
			}
			const meta = await getLibraryCacheMeta();
			if (aggressive || libraryCacheNeedsRebuild(meta)) {
				result.rebuiltLibraryCache = await maybeRebuildLibraryCache();
			}
		}
	}

	const after = await storageEstimate();
	console.debug(
		"[Bookmark Processor] Storage compact",
		JSON.stringify({ ...result, before, after, aggressive, safe }),
	);
	return result;
}
