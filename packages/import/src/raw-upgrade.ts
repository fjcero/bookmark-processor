import {
	articleRawFrom,
	articleResultFromTweet,
	findHydratedArticleResult,
	hasArticleBody,
	hasCompleteArticleRaw,
	isRicherArticlePayload,
	keepArticleRaw,
	mergeArticleIntoTweet,
} from "./article.ts";
import { isRicherTweetPayload } from "./tweet-richness.ts";

function extractQualityLost(incoming: unknown, existing: unknown): boolean {
	if (articleRawFrom(existing) != null && articleRawFrom(incoming) == null) {
		return true;
	}
	if (hasCompleteArticleRaw(existing) && !hasCompleteArticleRaw(incoming)) {
		return true;
	}
	return false;
}

function preserveExistingArticle(incoming: unknown, existing: unknown): unknown {
	let merged = keepArticleRaw(incoming, existing);
	if (!extractQualityLost(merged, existing)) return merged;
	const existingArticle =
		findHydratedArticleResult(existing) ?? articleResultFromTweet(existing);
	if (existingArticle && hasArticleBody(existingArticle)) {
		merged = keepArticleRaw(
			mergeArticleIntoTweet(merged, existingArticle),
			existing,
		);
	}
	return merged;
}

/**
 * Pick the payload to store, or null if `existing` should stay.
 * Incoming wins only for a richer article extract or a richer tweet envelope.
 * Size alone is not enough — a fatter history stub must not replace hydration.
 */
export function chooseBetterRaw(
	incoming: unknown,
	existing: unknown,
): unknown | null {
	if (incoming == null) return null;
	if (existing == null) return incoming;

	const merged = preserveExistingArticle(incoming, existing);
	if (isRicherArticlePayload(merged, existing)) return merged;
	if (isRicherTweetPayload(merged, existing)) return merged;
	return null;
}

export function chooseBetterRawJson(
	incomingJson: string,
	existingJson: string | null | undefined,
): string | null {
	if (!existingJson) return incomingJson;
	let incoming: unknown;
	let existing: unknown;
	try {
		incoming = JSON.parse(incomingJson) as unknown;
		existing = JSON.parse(existingJson) as unknown;
	} catch {
		return incomingJson.length > existingJson.length ? incomingJson : null;
	}
	const chosen = chooseBetterRaw(incoming, existing);
	if (chosen == null) return null;
	try {
		return JSON.stringify(chosen);
	} catch {
		return incomingJson;
	}
}
