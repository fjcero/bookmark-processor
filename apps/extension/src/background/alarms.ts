import { IMPORT_QUEUE_ALARM, processNextImport } from "../core/import-worker";
import { compactExtensionStorage } from "../core/storage-compact";
import { idbDelete, idbGet } from "../core/idb";
import type { AlarmRegistry } from "../core/platform";
import {
	STORAGE_COMPACT_ALARM,
	SYNC_STATUS_ALARM,
	SYNC_STATUS_ERROR_KEY,
	SYNC_STATUS_PUSH_ALARM,
} from "../core/constants";
import { scheduleSyncStatusPush, syncWithServer } from "./sync-server";

export function registerCoreAlarms(alarms: AlarmRegistry): void {
	alarms.register(IMPORT_QUEUE_ALARM, () => {
		void (async () => {
			const progress = await processNextImport();
			scheduleSyncStatusPush(progress.lastError);
		})();
	});
	alarms.register(SYNC_STATUS_ALARM, () => {
		void syncWithServer();
	});
	alarms.register(SYNC_STATUS_PUSH_ALARM, () => {
		void (async () => {
			const error = await idbGet<string>(SYNC_STATUS_ERROR_KEY);
			await idbDelete(SYNC_STATUS_ERROR_KEY);
			await syncWithServer(error ?? undefined);
		})();
	});
	alarms.register(STORAGE_COMPACT_ALARM, () => {
		void compactExtensionStorage();
	});
}

export function attachAlarmListener(alarms: AlarmRegistry): void {
	chrome.alarms.onAlarm.addListener((alarm) => {
		alarms.dispatch(alarm);
	});
}
