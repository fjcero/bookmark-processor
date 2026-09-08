import { SYNC_STATUS_ALARM } from "../core/constants";
import { processNextImport } from "../core/import-worker";
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
	await migrateLegacyPendingUpload();
	await processNextImport();
	for (const platform of getPlatforms()) {
		await platform.bootstrap();
	}
	void syncWithServer();
}

chrome.runtime.onInstalled.addListener(() => {
	clearLegacyStorage();
	void chrome.alarms.create(SYNC_STATUS_ALARM, { periodInMinutes: 1 });
	void startBackground();
});

chrome.runtime.onStartup.addListener(() => {
	void chrome.alarms.create(SYNC_STATUS_ALARM, { periodInMinutes: 1 });
	void startBackground();
});

void startBackground();
