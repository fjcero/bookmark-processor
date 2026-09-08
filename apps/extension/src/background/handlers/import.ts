import type { ExportPayload, LibraryStats } from "@repo/import/capture/engine";
import { fetchLibraryStats } from "@repo/import/capture/engine";
import {
	enqueueImportPayload,
	processNextImport,
} from "../../core/import-worker";
import type { MessageRouter } from "../../core/platform";
import { scheduleSyncStatusPush } from "../sync-server";

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
}
