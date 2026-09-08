import {
	articleQueueStats,
	markArticleRemoved,
	type ArticleQueueCounts,
	type SyncRevocation,
} from "@repo/import";
import { idbGet } from "../../core/idb";
import type {
	AlarmRegistry,
	ExtensionPlatform,
	MessageRouter,
	StatusSlice,
} from "../../core/platform";
import {
	ALARM_NAME,
	loadArticleQueue,
	loadHydrationState,
	updateArticleQueue,
} from "./article-queue";
import { bootstrapArticles, failTab, hydrateNext } from "./article-hydration";
import { registerXMessageHandlers } from "./handlers";
import {
	findOpenedTab,
	loadWorkerTabId,
	saveWorkerTabId,
} from "./article-tabs";
import {
	ARTICLE_TIMEOUT_PREFIX,
	CAPTURE_SCROLL_KEY,
	X_TAB_URL_PATTERNS,
} from "./constants";

export function createXPlatform(): ExtensionPlatform {
	return {
		id: "x",
		tabUrlPatterns: X_TAB_URL_PATTERNS,
		async bootstrap() {
			await bootstrapArticles();
		},
		registerMessageHandlers(router: MessageRouter) {
			registerXMessageHandlers(router);
		},
		registerAlarmHandlers(alarms: AlarmRegistry) {
			alarms.register(ALARM_NAME, () => {
				void hydrateNext();
			});
			alarms.register(ARTICLE_TIMEOUT_PREFIX, (alarm) => {
				const tabId = Number(alarm.name.slice(ARTICLE_TIMEOUT_PREFIX.length));
				if (Number.isInteger(tabId)) {
					void failTab(tabId, "Timed out waiting for article body");
				}
			});
		},
		async onTabRemoved(tabId: number) {
			const workerId = await loadWorkerTabId();
			if (workerId === tabId) await saveWorkerTabId(null);
			const opened = await findOpenedTab(tabId);
			if (opened) await failTab(tabId, "Article tab closed");
		},
		async buildStatusSlice(): Promise<StatusSlice> {
			const queue = await loadArticleQueue();
			const hydration = await loadHydrationState();
			const captureScrollActive =
				(await idbGet<boolean>(CAPTURE_SCROLL_KEY)) ?? false;
			const articles: ArticleQueueCounts = articleQueueStats(queue);
			return {
				articles,
				articleQueue: queue
					.filter((item) => item.status !== "ok")
					.slice(0, 100),
				captureScrollActive,
				rateLimitedUntil: hydration.rateLimitedUntil,
			};
		},
		async applyRevocations(revocations: SyncRevocation[]) {
			if (revocations.length === 0) return;
			await updateArticleQueue((queue) => {
				let next = queue;
				for (const rev of revocations) {
					if (rev.articleId) {
						next = markArticleRemoved(next, rev.articleId);
					}
				}
				return next;
			});
		},
	};
}
