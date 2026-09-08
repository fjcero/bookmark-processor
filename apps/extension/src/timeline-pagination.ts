import type { CaptureEventDetail } from "@repo/import/capture/hooks-events";
import { applySortIndexes } from "@repo/import";

export interface TimelineJob {
	source: "bookmark" | "like" | "history";
	pageUrl: string;
	request: NonNullable<CaptureEventDetail["request"]> & {
		url: string;
		method: string;
	};
	cursor: string;
	pages: number;
	captured: number;
	imported: number;
	skipped: number;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function findBottomCursor(value: unknown, depth = 0): string | null {
	if (!value || typeof value !== "object" || depth > 18) return null;
	if (Array.isArray(value)) {
		for (const item of value) {
			const cursor = findBottomCursor(item, depth + 1);
			if (cursor) return cursor;
		}
		return null;
	}

	const item = value as Record<string, unknown>;
	const content = record(item.content);
	const cursorType = String(item.cursorType ?? content?.cursorType ?? "");
	const cursorValue = item.value ?? content?.value;
	if (
		(cursorType.toLowerCase() === "bottom" ||
			String(item.entryId ?? "").includes("cursor-bottom")) &&
		typeof cursorValue === "string"
	) {
		return cursorValue;
	}

	for (const child of Object.values(item)) {
		const cursor = findBottomCursor(child, depth + 1);
		if (cursor) return cursor;
	}
	return null;
}

export function collectTimelineTweets(value: unknown): Record<string, unknown> {
	const tweets: Record<string, unknown> = {};
	const visited = new Set<object>();

	function visit(node: unknown, depth: number): void {
		if (!node || typeof node !== "object" || depth > 14 || visited.has(node)) {
			return;
		}
		visited.add(node);
		if (Array.isArray(node)) {
			for (const child of node) visit(child, depth + 1);
			return;
		}

		const item = node as Record<string, unknown>;
		const result = record(record(item.tweet_results)?.result);
		if (result) {
			const unwrapped =
				result.__typename === "TweetWithVisibilityResults" ||
				result.__typename === "TweetWithVisibilityResult"
					? record(result.tweet)
					: result;
			if (typeof unwrapped?.rest_id === "string") {
				tweets[unwrapped.rest_id] = unwrapped;
			}
		} else if (
			typeof item.rest_id === "string" &&
			item.__typename !== "User" &&
			(item.legacy != null || item.core != null)
		) {
			tweets[item.rest_id] = item;
		}

		for (const [key, child] of Object.entries(item)) {
			if (key !== "quoted_status_result") visit(child, depth + 1);
		}
	}

	visit(value, 0);
	applySortIndexes(tweets, value);
	return tweets;
}

export function createTimelineJob(
	detail: CaptureEventDetail,
	source: TimelineJob["source"],
	pageUrl: string,
): TimelineJob | null {
	if (!detail.request || !detail.url.includes("/graphql/")) return null;
	const cursor = findBottomCursor(detail.data);
	if (!cursor || Object.keys(collectTimelineTweets(detail.data)).length === 0) {
		return null;
	}
	return {
		source,
		pageUrl,
		request: {
			url: detail.url,
			method: detail.method,
			headers: detail.request.headers,
			body: detail.request.body,
		},
		cursor,
		pages: 0,
		captured: 0,
		imported: 0,
		skipped: 0,
	};
}

export function requestForCursor(
	job: TimelineJob,
	cursor: string,
): { url: string; body?: string } {
	const url = new URL(job.request.url);
	const variablesRaw = url.searchParams.get("variables");
	if (variablesRaw) {
		const variables = JSON.parse(variablesRaw) as Record<string, unknown>;
		variables.cursor = cursor;
		url.searchParams.set("variables", JSON.stringify(variables));
		return { url: url.toString(), body: job.request.body };
	}

	if (job.request.body) {
		const body = JSON.parse(job.request.body) as Record<string, unknown>;
		const variables = record(body.variables) ?? body;
		variables.cursor = cursor;
		return { url: url.toString(), body: JSON.stringify(body) };
	}

	throw new Error("Timeline request has no cursor variables");
}
