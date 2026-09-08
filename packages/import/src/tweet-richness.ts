/** Heuristics for deciding when an incoming tweet JSON should replace a stub. */

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function unwrapTweet(tweet: unknown): Record<string, unknown> | null {
	const obj = asRecord(tweet);
	if (!obj) return null;
	if (
		obj.__typename === "TweetWithVisibilityResults" ||
		obj.__typename === "TweetWithVisibilityResult"
	) {
		return asRecord(obj.tweet) ?? obj;
	}
	return obj;
}

function tweetTextLength(tweet: Record<string, unknown>): number {
	const note = asRecord(asRecord(asRecord(tweet.note_tweet)?.note_tweet_results)?.result);
	const noteText = asString(note?.text);
	if (noteText) return noteText.length;
	const legacy = asRecord(tweet.legacy) ?? tweet;
	return asString(legacy.full_text)?.length ?? 0;
}

function hasNode(tweet: Record<string, unknown>, ...path: string[]): boolean {
	let cur: unknown = tweet;
	for (const key of path) {
		cur = asRecord(cur)?.[key];
		if (cur == null) return false;
	}
	return true;
}

function hasQuoted(tweet: Record<string, unknown>): boolean {
	return (
		hasNode(tweet, "quoted_status_result", "result") ||
		hasNode(tweet, "quoted_ref_result", "result") ||
		hasNode(tweet, "legacy", "quoted_status_result", "result") ||
		Boolean(asString(asRecord(tweet.legacy)?.quoted_status_id_str)) ||
		Boolean(asString(tweet.quoted_status_id_str)) ||
		Boolean(asString(tweet.quoted_tweet_id_str))
	);
}

function hasRetweeted(tweet: Record<string, unknown>): boolean {
	return (
		hasNode(tweet, "retweeted_status_result", "result") ||
		hasNode(tweet, "legacy", "retweeted_status_result", "result") ||
		Boolean(asString(asRecord(tweet.legacy)?.retweeted_status_id_str))
	);
}

function hasMedia(tweet: Record<string, unknown>): boolean {
	const legacy = asRecord(tweet.legacy) ?? {};
	const extended = asRecord(legacy.extended_entities) ?? asRecord(tweet.extended_entities);
	const entities = asRecord(legacy.entities) ?? asRecord(tweet.entities);
	const media = extended?.media ?? entities?.media;
	return Array.isArray(media) && media.length > 0;
}

/**
 * Relative completeness score for a tweet GraphQL object.
 * Higher means more usable library data (quotes, media, long text, etc.).
 */
export function tweetPayloadScore(tweet: unknown): number {
	const obj = unwrapTweet(tweet);
	if (!obj) return 0;
	let score = 0;
	score += Math.min(tweetTextLength(obj), 2000);
	if (hasQuoted(obj)) score += 5000;
	if (hasRetweeted(obj)) score += 5000;
	if (hasNode(obj, "note_tweet")) score += 2000;
	if (hasMedia(obj)) score += 1500;
	if (hasNode(obj, "card") || hasNode(obj, "tweet_card")) score += 800;
	if (hasNode(obj, "article")) score += 800;
	if (hasNode(obj, "views")) score += 50;
	if (hasNode(obj, "legacy", "entities", "urls")) score += 100;
	// Prefer fuller GraphQL blobs over hand-built stubs.
	try {
		score += Math.min(JSON.stringify(obj).length, 20000) / 20;
	} catch {
		/* ignore */
	}
	return score;
}

/** True when `incoming` should replace `existing` raw tweet JSON. */
export function isRicherTweetPayload(incoming: unknown, existing: unknown): boolean {
	const next = tweetPayloadScore(incoming);
	const prev = tweetPayloadScore(existing);
	if (next <= prev) return false;
	// Require a meaningful upgrade so near-equal reimports don't thrash.
	return next >= prev + 400;
}
