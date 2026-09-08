import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE_RAW_KEY } from "./article.ts";
import { chooseBetterRaw, chooseBetterRawJson } from "./raw-upgrade.ts";

const stub = {
	__typename: "Tweet",
	rest_id: "1",
	legacy: { full_text: "preview" },
};

const hydrated = {
	__typename: "Tweet",
	rest_id: "1",
	legacy: { full_text: "preview" },
	article: {
		article_results: {
			result: {
				rest_id: "a1",
				title: "Title",
				preview_text: "preview",
				content_state: {
					blocks: [
						{
							text: "preview Then the real piece continues with architecture tradeoffs and why the first database choice stopped working once volume scaled.",
						},
					],
				},
			},
		},
	},
	[ARTICLE_RAW_KEY]: {
		data: { article: { title: "full GraphQL envelope" } },
	},
};

const quotedHistory = {
	__typename: "Tweet",
	rest_id: "1",
	legacy: {
		full_text: "x".repeat(500),
		quoted_status_id_str: "2",
	},
	quoted_status_result: {
		result: {
			__typename: "Tweet",
			rest_id: "2",
			legacy: { full_text: "quoted" },
		},
	},
};

test("chooseBetterRawJson inserts when nothing is stored yet", () => {
	const incoming = JSON.stringify(stub);
	assert.equal(chooseBetterRawJson(incoming, null), incoming);
	assert.equal(chooseBetterRawJson(incoming, undefined), incoming);
});

test("rejects a weaker history payload over a hydrated article", () => {
	assert.equal(chooseBetterRaw(stub, hydrated), null);
	assert.equal(
		chooseBetterRawJson(JSON.stringify(stub), JSON.stringify(hydrated)),
		null,
	);
});

test("merges _articleRaw onto a richer tweet envelope", () => {
	const chosen = chooseBetterRaw(quotedHistory, hydrated) as Record<
		string,
		unknown
	>;
	assert.ok(chosen);
	assert.deepEqual(chosen[ARTICLE_RAW_KEY], hydrated[ARTICLE_RAW_KEY]);
	assert.equal(
		(chosen.quoted_status_result as { result?: { rest_id?: string } })?.result
			?.rest_id,
		"2",
	);
});

test("accepts a longer article extract", () => {
	const longer = {
		...hydrated,
		article: {
			article_results: {
				result: {
					rest_id: "a1",
					title: "Title",
					preview_text: "preview",
					content_state: {
						blocks: [
							{
								text: `${"body ".repeat(80)}extra extract from a later GraphQL capture.`,
							},
						],
					},
				},
			},
		},
	};
	const chosen = chooseBetterRaw(longer, hydrated);
	assert.ok(chosen);
	assert.equal(chooseBetterRaw(hydrated, longer), null);
});
