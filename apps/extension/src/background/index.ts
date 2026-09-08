import { STORAGE_COMPACT_ALARM, SYNC_STATUS_ALARM } from "../core/constants";
import { setQuotaRecoveryHandler } from "../core/idb";
import { processNextImport } from "../core/import-worker";
import { compactExtensionStorage } from "../core/storage-compact";
import {
	AlarmRegistry,
	getPlatforms,
	MessageRouter,
	registerPlatform,
} from "../core/platform";
import { createXPlatform } from "../platforms/x";
import { registerCoreAlarms, attachAlarmListener } from "./alarms";
import { registerCaptureStateHandlers } from "./handlers/capture-state";
import { registerImportHandlers } from "./handlers/import";
import { clearLegacyStorage, migrateLegacyPendingUpload } from "./migrations";
import { attachMessageListener } from "./router";
import { syncWithServer } from "./sync-server";

const router = new MessageRouter();
const alarms = new AlarmRegistry();

setQuotaRecoveryHandler(async () => {
	await compactExtensionStorage({ aggressive: true });
});
registerCaptureStateHandlers(router);
registerImportHandlers(router);
registerCoreAlarms(alarms);

const x = createXPlatform();
registerPlatform(x);
x.registerMessageHandlers(router);
x.registerAlarmHandlers(alarms);

attachMessageListener(router);
attachAlarmListener(alarms);

chrome.tabs.onRemoved.addListener((tabId) => {
	void (async () => {
		for (const platform of getPlatforms()) {
			await platform.onTabRemoved(tabId);
		}
	})();
});

async function startBackground(): Promise<void> {
	scheduleStorageCompactAlarm();
	await migrateLegacyPendingUpload();
	await processNextImport();
	for (const platform of getPlatforms()) {
		await platform.bootstrap();
	}
	void syncWithServer();
}

function scheduleStorageCompactAlarm(): void {
	void chrome.alarms.create(STORAGE_COMPACT_ALARM, { periodInMinutes: 360 });
	void chrome.alarms.create(SYNC_STATUS_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
	clearLegacyStorage();
	scheduleStorageCompactAlarm();
	void startBackground();
});

chrome.runtime.onStartup.addListener(() => {
	scheduleStorageCompactAlarm();
	void startBackground();
});

void startBackground();
