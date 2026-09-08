import {
	articleQueueStats,
	enqueueArticles,
	markArticleRateLimited,
	parseRetryAfterMs,
	retryFailedArticles,
	isSafeArticleReplayUrl,
	ARTICLE_RATE_LIMIT_MS,
	type GraphQLArticleResult,
} from "@repo/import";
import type { CaptureEventDetail } from "@repo/import/capture/hooks-events";
import type { MessageRouter } from "../../core/platform";
import { idbGet, idbSet } from "../../core/idb";
import {
	loadArticleQueue,
	loadHydrationState,
	noteRateLimited,
	releaseArticleLease,
	updateArticleQueue,
} from "./article-queue";
import {
	createArticleRequestTemplate,
	type ArticleRequestTemplate,
} from "./article-replay";
import { closeHydrationTab, loadOpenedTabs } from "./article-tabs";
import { ARTICLE_TEMPLATE_KEY, CAPTURE_SCROLL_KEY } from "./constants";
import {
	broadcastStats,
	captureArticleBody,
	handleArticleUnavailable,
	ingestPendingFromServer,
	scheduleNext,
} from "./article-hydration";

export function registerXMessageHandlers(router: MessageRouter): void {
	router.register("bp-enqueue-articles", async (message) => {
		const incoming = Array.isArray(message.articles) ? message.articles : [];
		await updateArticleQueue((queue) => enqueueArticles(queue, incoming));
		await broadcastStats();
		await scheduleNext();
		return { ok: true };
	});

	router.register("bp-article-template", async (message) => {
		const template = createArticleRequestTemplate(
			message.detail as CaptureEventDetail,
			String(message.articleId),
		);
		if (!template) return { accepted: false };
		if (!isSafeArticleReplayUrl(template.url)) {
			return { accepted: false };
		}
		const existing = await idbGet<ArticleRequestTemplate>(ARTICLE_TEMPLATE_KEY);
		if (
			existing &&
			/ArticleEntity/i.test(existing.url) &&
			!/ArticleEntity/i.test(template.url)
		) {
			return { accepted: false };
		}
		await idbSet(ARTICLE_TEMPLATE_KEY, template);
		return { accepted: true };
	});

	router.register("bp-article-body", async (message, sender) => {
		await captureArticleBody(
			message.article as GraphQLArticleResult,
			sender.tab?.id,
			message.raw,
		);
		return { ok: true };
	});

	router.register("bp-article-unavailable", async (message, sender) => {
		return {
			removed: await handleArticleUnavailable(
				String(message.articleId),
				sender.tab?.id,
			),
		};
	});

	router.register("bp-article-retry", async () => {
		await updateArticleQueue((queue) => retryFailedArticles(queue));
		await broadcastStats();
		await scheduleNext();
		return { ok: true };
	});

	router.register("bp-refresh-articles", async () => {
		await ingestPendingFromServer();
		await scheduleNext();
		return { ok: true };
	});

	router.register("bp-capture-scroll", async (message) => {
		const active = Boolean(message.active);
		await idbSet(CAPTURE_SCROLL_KEY, active);
		if (!active) {
			await scheduleNext();
		}
		return { ok: true };
	});

	router.register("bp-article-rate-limited", async (message) => {
		const delay = parseRetryAfterMs(
			message.retryAfter != null ? String(message.retryAfter) : null,
			ARTICLE_RATE_LIMIT_MS,
		);
		await noteRateLimited(delay);
		const limited = await loadHydrationState();
		const opened = await loadOpenedTabs();
		if (opened.length > 0) {
			const current = opened[0]!;
			await closeHydrationTab(current.tabId);
			await updateArticleQueue((items) =>
				markArticleRateLimited(
					items,
					current.articleId,
					"X rate limited article request (429)",
					Date.now(),
					limited.rateLimitHits ?? 1,
				),
			);
			await releaseArticleLease(current.articleId);
			await broadcastStats();
		}
		await scheduleNext(delay);
		return { ok: true };
	});

	router.register("bp-article-stats-request", async () => {
		return { stats: articleQueueStats(await loadArticleQueue()) };
	});
}
