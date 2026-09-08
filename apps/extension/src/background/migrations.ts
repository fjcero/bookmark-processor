import type { ExportPayload } from "@repo/import/capture/engine";
import { PENDING_UPLOAD_KEY } from "../core/constants";
import { idbDelete, idbGet } from "../core/idb";
import { enqueueImportPayload } from "../core/import-worker";

const LEGACY_STORAGE_KEY = "x-export-v2-state";

export async function migrateLegacyPendingUpload(): Promise<void> {
	const pending = await idbGet<{
		payload: ExportPayload;
		serverUrl: string;
	}>(PENDING_UPLOAD_KEY);
	if (!pending) return;
	await enqueueImportPayload(pending.payload, pending.serverUrl);
	await idbDelete(PENDING_UPLOAD_KEY);
	await chrome.alarms.clear("bp-sync-retry");
}

export function clearLegacyStorage(): void {
	chrome.storage.local.remove(LEGACY_STORAGE_KEY).catch(() => {
		/* ignore */
	});
}
