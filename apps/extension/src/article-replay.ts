import {
	articleRestId,
	findHydratedArticleResult,
	isSafeArticleReplayUrl,
	requestMentionsArticle,
	withArticleBodyToggles,
} from "@repo/import";
import type { CaptureEventDetail } from "@repo/import/capture/hooks-events";

export interface ArticleRequestTemplate {
	articleId: string;
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export function createArticleRequestTemplate(
	detail: CaptureEventDetail,
	pageArticleId: string,
): ArticleRequestTemplate | null {
	if (!detail.request || !isSafeArticleReplayUrl(detail.url)) return null;
	if (!requestMentionsArticle(detail.url, detail.request.body, pageArticleId)) {
		return null;
	}
	const article = findHydratedArticleResult(detail.data);
	const articleId =
		articleRestId(article) ??
		(pageArticleId.length > 0 ? pageArticleId : null);
	if (!articleId) return null;
	return {
		articleId,
		url: detail.url,
		method: detail.method,
		headers: detail.request.headers,
		body: detail.request.body,
	};
}

function replaceId(value: unknown, from: string, to: string): boolean {
	let replaced = false;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (value[index] === from) {
				value[index] = to;
				replaced = true;
			} else if (value[index] && typeof value[index] === "object") {
				replaced = replaceId(value[index], from, to) || replaced;
			}
		}
		return replaced;
	}
	if (!value || typeof value !== "object") return false;
	const object = value as Record<string, unknown>;
	for (const [key, child] of Object.entries(object)) {
		if (child === from) {
			object[key] = to;
			replaced = true;
		} else if (child && typeof child === "object") {
			replaced = replaceId(child, from, to) || replaced;
		}
	}
	return replaced;
}

export function requestForArticle(
	template: ArticleRequestTemplate,
	articleId: string,
): { url: string; body?: string } {
	if (!isSafeArticleReplayUrl(template.url)) {
		throw new Error("Refusing to replay a non-article GraphQL request");
	}
	const url = new URL(template.url);
	let replaced = false;

	for (const [key, raw] of url.searchParams) {
		if (raw === template.articleId) {
			url.searchParams.set(key, articleId);
			replaced = true;
			continue;
		}
		if (!raw.startsWith("{") && !raw.startsWith("[")) continue;
		try {
			const parsed = JSON.parse(raw);
			if (replaceId(parsed, template.articleId, articleId)) {
				url.searchParams.set(key, JSON.stringify(parsed));
				replaced = true;
			}
		} catch {
			/* non-JSON parameter */
		}
	}

	let body = template.body;
	if (body) {
		try {
			const parsed = JSON.parse(body);
			if (replaceId(parsed, template.articleId, articleId)) {
				body = JSON.stringify(parsed);
				replaced = true;
			}
		} catch {
			/* non-JSON body */
		}
	}

	if (!replaced && url.pathname.includes(template.articleId)) {
		url.pathname = url.pathname.replace(template.articleId, articleId);
		replaced = true;
	}
	if (!replaced) throw new Error("Article request does not contain its article id");
	return withArticleBodyToggles(url.toString(), body);
}
