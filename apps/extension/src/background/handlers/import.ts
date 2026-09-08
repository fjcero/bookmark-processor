import type { ExportPayload } from "@repo/import/capture/engine";
import {
	fetchAllLibraryExternalIds,
	fetchLibraryStats,
	fetchTodayImportStats,
	filterKnownExternalIds,
} from "@repo/import/capture/engine";
import {
	enqueueImportPayload,
	processNextImport,
} from "../../core/import-worker";
import { loadLibraryCache, replaceLibraryCache, saveLibraryCache } from "../../core/library-cache";
import { compactExtensionStorage } from "../../core/storage-compact";
import type { MessageRouter } from "../../core/platform";
import { scheduleSyncStatusPush } from "../sync-server";
import { reconcileArticleQueueWithServer } from "../../platforms/x/article-hydration";

export function registerImportHandlers(router: MessageRouter): void {
	router.register("bp-import-enqueue", async (message) => {
		await enqueueImportPayload(
			message.payload as ExportPayload,
			String(message.serverUrl),
		);
		const progress = await processNextImport();
		scheduleSyncStatusPush(progress.lastError);
		return progress;
	});
	router.register("bp-fetch-total", async (message) => {
		return await fetchLibraryStats(String(message.serverUrl));
	});
	router.register("bp-fetch-today", async (message) => {
		return await fetchTodayImportStats(String(message.serverUrl));
	});
	router.register("bp-filter-known", async (message) => {
		const externalIds = Array.isArray(message.externalIds)
			? message.externalIds.map(String)
			: [];
		const source = typeof message.source === "string" ? message.source : "x";
		const known = await filterKnownExternalIds(
			String(message.serverUrl),
			externalIds,
			source,
		);
		if (known.length > 0) await saveLibraryCache(known);
		return { known };
	});
	router.register("bp-hydrate-library-cache", async (message) => {
		const serverUrl = String(message.serverUrl);
		const cached = await loadLibraryCache();
		const fetched = await fetchAllLibraryExternalIds(serverUrl);
		if (fetched.length > 0) await replaceLibraryCache(fetched);
		const ids = await loadLibraryCache();
		return { count: ids.size, cached: cached.size };
	});
	router.register("bp-library-cache-load", async () => {
		const ids = await loadLibraryCache();
		return { ids: [...ids] };
	});
	router.register("bp-library-cache-save", async (message) => {
		const ids = Array.isArray(message.ids) ? message.ids.map(String) : [];
		await saveLibraryCache(ids);
		return { ok: true };
	});
	router.register("bp-reconcile-articles", async (message) => {
		const removed = await reconcileArticleQueueWithServer(
			String(message.serverUrl),
		);
		return { removed };
	});
	router.register("bp-compact-storage", async (message) => {
		return compactExtensionStorage({
			aggressive: Boolean(message.aggressive),
		});
	});
}
