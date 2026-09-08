import { and, eq, like, or, sql, type SQL } from "drizzle-orm";
import { items, itemRaw, users } from "@repo/db";
import type { ContentType, PostFormat } from "@repo/import";

export interface ItemSearchFilters {
	q?: string;
	contentType?: ContentType;
	postFormat?: PostFormat;
}

const TYPE_KEYWORDS: Record<
	string,
	{ contentType?: ContentType; postFormat?: PostFormat }
> = {
	article: { contentType: "article" },
	articles: { contentType: "article" },
	post: { contentType: "post" },
	posts: { contentType: "post" },
	reply: { postFormat: "reply" },
	replies: { postFormat: "reply" },
	quote: { postFormat: "quote" },
	quotes: { postFormat: "quote" },
	repost: { postFormat: "repost" },
	reposts: { postFormat: "repost" },
	retweet: { postFormat: "repost" },
	retweets: { postFormat: "repost" },
	thread: { postFormat: "thread" },
	threads: { postFormat: "thread" },
};

function replyCondition(): SQL {
	return sql`(
		json_extract(${itemRaw.payload}, '$.legacy.in_reply_to_status_id_str') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.in_reply_to_tweet_id') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.in_reply_to_status_id_str') IS NOT NULL
	)`;
}

function repostCondition(): SQL {
	return sql`(
		json_extract(${itemRaw.payload}, '$.legacy.retweeted_status_id_str') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.retweeted_status_result') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.legacy.retweeted_status_result') IS NOT NULL
	)`;
}

function quoteCondition(): SQL {
	return sql`(
		json_extract(${itemRaw.payload}, '$.legacy.quoted_status_id_str') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.quoted_status_id_str') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.quoted_tweet_id_str') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.quoted_status_result') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.quoted_ref_result') IS NOT NULL
	)`;
}

function threadCondition(): SQL {
	return sql`(
		json_extract(${itemRaw.payload}, '$.legacy.self_thread') IS NOT NULL
		OR json_extract(${itemRaw.payload}, '$.self_thread') IS NOT NULL
	)`;
}

function formattedPostCondition(): SQL {
	return sql`(${replyCondition()} OR ${repostCondition()} OR ${quoteCondition()} OR ${threadCondition()})`;
}

export function postFormatCondition(format: PostFormat): SQL {
	switch (format) {
		case "reply":
			return replyCondition();
		case "repost":
			return repostCondition();
		case "quote":
			return quoteCondition();
		case "thread":
			return threadCondition();
		case "original":
			return sql`NOT ${formattedPostCondition()}`;
	}
}

function termMatches(term: string): SQL {
	const pattern = `%${term}%`;
	const keyword = TYPE_KEYWORDS[term.toLowerCase()];
	const textMatch =
		or(
			like(items.text, pattern),
			like(users.name, pattern),
			like(users.handle, pattern),
			like(items.entities, pattern),
			like(items.understanding, pattern),
			like(items.kind, pattern),
			sql`json_extract(${itemRaw.payload}, '$.article.article_results.result.title') LIKE ${pattern}`,
			sql`json_extract(${itemRaw.payload}, '$.article.article_results.result.preview_text') LIKE ${pattern}`,
			sql`json_extract(${itemRaw.payload}, '$.article.article_results.result.summary_text') LIKE ${pattern}`,
		) ?? sql`0`;

	if (!keyword) return textMatch;

	const keywordMatch: SQL[] = [];
	if (keyword.contentType) {
		keywordMatch.push(eq(items.contentType, keyword.contentType));
	}
	if (keyword.postFormat) {
		keywordMatch.push(postFormatCondition(keyword.postFormat));
	}
	return or(textMatch, and(...keywordMatch)) ?? textMatch;
}

export function buildItemSearchWhere(filters: ItemSearchFilters): SQL | undefined {
	const parts: SQL[] = [];

	const q = filters.q?.trim();
	if (q) {
		const terms = q.split(/\s+/).filter(Boolean);
		for (const term of terms) {
			parts.push(termMatches(term));
		}
	}

	if (filters.contentType) {
		parts.push(eq(items.contentType, filters.contentType));
	}
	if (filters.postFormat) {
		parts.push(postFormatCondition(filters.postFormat));
	}

	if (parts.length === 0) return undefined;
	return and(...parts);
}

export function hasActiveSearch(filters: ItemSearchFilters): boolean {
	return Boolean(
		filters.q?.trim() ||
			filters.contentType ||
			filters.postFormat,
	);
}
