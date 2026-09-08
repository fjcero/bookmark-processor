import {
	articleMediaUrls,
	articlePlainText,
	articleResultFromTweet,
	articleUrl,
} from "@repo/import";
import { extractMediaUrls } from "./entities";

export interface EmbeddedTweet {
	type: "quote" | "retweet";
	id: string;
	text: string;
	handle: string;
	name: string;
	avatarUrl: string | null;
	url: string;
	mediaUrls: string[];
}

function safeGet(obj: unknown, ...keys: string[]): unknown {
	let cur: unknown = obj;
	for (const k of keys) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

function unwrapTweet(tweet: unknown): Record<string, unknown> | null {
	if (!tweet || typeof tweet !== "object") return null;
	const obj = tweet as Record<string, unknown>;
	if (
		obj.__typename === "TweetWithVisibilityResults" ||
		obj.__typename === "TweetWithVisibilityResult"
	) {
		const inner = obj.tweet;
		if (inner && typeof inner === "object") {
			return inner as Record<string, unknown>;
		}
	}
	return obj;
}

function tweetText(tweet: Record<string, unknown>): string {
	const note = safeGet(
		tweet,
		"note_tweet",
		"note_tweet_results",
		"result",
		"text",
	);
	if (note) return String(note);
	const article = articleResultFromTweet(tweet);
	if (article) return articlePlainText(article);
	return String(safeGet(tweet, "legacy", "full_text") ?? "");
}

function tweetUser(tweet: Record<string, unknown>) {
	const user = safeGet(tweet, "core", "user_results", "result");
	if (!user || typeof user !== "object") {
		return { handle: "", name: "", avatarUrl: null };
	}
	const u = user as Record<string, unknown>;
	const handle = String(
		safeGet(u, "core", "screen_name") ??
			safeGet(u, "legacy", "screen_name") ??
			"",
	);
	const name = String(
		safeGet(u, "core", "name") ?? safeGet(u, "legacy", "name") ?? handle,
	);
	const avatarUrl =
		String(
			safeGet(u, "avatar", "image_url") ??
				safeGet(u, "legacy", "profile_image_url_https") ??
				"",
		) || null;
	return { handle, name, avatarUrl };
}

function statusUrl(
	source: string,
	id: string,
	handle: string,
): string {
	if (source === "x" && handle) {
		return `https://x.com/${handle}/status/${id}`;
	}
	return `https://x.com/i/status/${id}`;
}

function nodeAt(
	parent: Record<string, unknown>,
	path: string[],
): Record<string, unknown> | null {
	let cur: unknown = parent;
	for (const key of path) {
		if (!cur || typeof cur !== "object") return null;
		cur = (cur as Record<string, unknown>)[key];
	}
	return unwrapTweet(cur);
}

function buildEmbed(
	tweet: Record<string, unknown>,
	type: EmbeddedTweet["type"],
	source: string,
): EmbeddedTweet | null {
	const id = String(tweet.rest_id ?? "");
	if (!id) return null;
	const { handle, name, avatarUrl } = tweetUser(tweet);
	const text = tweetText(tweet).trim();
	const article = articleResultFromTweet(tweet);
	const mediaUrls = [
		...new Set([
			...extractMediaUrls(JSON.stringify(tweet)),
			...articleMediaUrls(article),
		]),
	];
	const articleId = article?.rest_id;
	return {
		type,
		id,
		text,
		handle,
		name: name || handle || id,
		avatarUrl,
		url: articleId ? articleUrl(articleId) : statusUrl(source, id, handle),
		mediaUrls,
	};
}

function stubEmbed(
	type: EmbeddedTweet["type"],
	id: string,
	source: string,
): EmbeddedTweet {
	return {
		type,
		id,
		text: "",
		handle: "",
		name: type === "retweet" ? "Reposted post" : "Quoted post",
		avatarUrl: null,
		url: statusUrl(source, id, ""),
		mediaUrls: [],
	};
}

export function extractEmbeds(
	rawJson: string,
	source = "x",
): EmbeddedTweet[] {
	if (!rawJson) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return [];
	}
	const tweet = unwrapTweet(parsed);
	if (!tweet) return [];

	const embeds: EmbeddedTweet[] = [];

	const quoted =
		nodeAt(tweet, ["quoted_status_result", "result"]) ??
		nodeAt(tweet, ["quoted_ref_result", "result"]) ??
		nodeAt(tweet, ["legacy", "quoted_status_result", "result"]);
	if (quoted) {
		const embed = buildEmbed(quoted, "quote", source);
		if (embed) embeds.push(embed);
	} else {
		const quotedId = String(
			safeGet(tweet, "quoted_status_id_str") ??
				safeGet(tweet, "legacy", "quoted_status_id_str") ??
				"",
		);
		if (quotedId) embeds.push(stubEmbed("quote", quotedId, source));
	}

	const retweeted =
		nodeAt(tweet, ["retweeted_status_result", "result"]) ??
		nodeAt(tweet, ["legacy", "retweeted_status_result", "result"]);
	if (retweeted) {
		const embed = buildEmbed(retweeted, "retweet", source);
		if (embed) embeds.push(embed);
	} else {
		const retweetId = String(
			safeGet(tweet, "legacy", "retweeted_status_id_str") ?? "",
		);
		if (retweetId) embeds.push(stubEmbed("retweet", retweetId, source));
	}

	return embeds;
}
