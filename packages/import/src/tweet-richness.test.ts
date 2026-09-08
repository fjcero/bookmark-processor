import assert from "node:assert/strict";
import test from "node:test";
import { isRicherTweetPayload, tweetPayloadScore } from "./tweet-richness.ts";

const stub = {
	__typename: "Tweet",
	rest_id: "1",
	legacy: { full_text: "Agents and Linear documents." },
};

const withQuote = {
	__typename: "Tweet",
	rest_id: "1",
	legacy: {
		full_text: "Agents and Linear documents.",
		is_quote_status: true,
		quoted_status_id_str: "2",
	},
	quoted_status_result: {
		result: {
			__typename: "Tweet",
			rest_id: "2",
			legacy: { full_text: "Quoted body with more detail here." },
			core: {
				user_results: {
					result: {
						core: { screen_name: "faruk_parhat", name: "Faruk" },
					},
				},
			},
		},
	},
};

test("scores quote payloads higher than stubs", () => {
	assert.ok(tweetPayloadScore(withQuote) > tweetPayloadScore(stub) + 400);
	assert.equal(isRicherTweetPayload(withQuote, stub), true);
	assert.equal(isRicherTweetPayload(stub, withQuote), false);
	assert.equal(isRicherTweetPayload(withQuote, withQuote), false);
});

test("never treats a tweet without _articleRaw as richer than one that has it", () => {
	const hydrated = {
		__typename: "Tweet",
		rest_id: "1",
		legacy: { full_text: "short" },
		_articleRaw: { data: { article: { title: "full body captured from X" } } },
	};
	const quoted = {
		__typename: "Tweet",
		rest_id: "1",
		legacy: {
			full_text: "x".repeat(500),
			quoted_status_id_str: "2",
		},
		quoted_status_result: {
			result: { __typename: "Tweet", rest_id: "2", legacy: { full_text: "q" } },
		},
	};
	assert.equal(isRicherTweetPayload(quoted, hydrated), false);
});

test("treats substantially longer text as richer", () => {
	const short = { legacy: { full_text: "hi" } };
	const long = {
		legacy: {
			full_text: "x".repeat(500),
		},
		views: { count: "1" },
	};
	assert.equal(isRicherTweetPayload(long, short), true);
});

test("does not treat incoming as richer when there is no existing payload", () => {
	assert.equal(isRicherTweetPayload(stub, undefined), false);
	assert.equal(isRicherTweetPayload(stub, null), false);
});
