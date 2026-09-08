import assert from "node:assert/strict";
import { test } from "node:test";
import { toPersistedCaptureState } from "../capture/persist-state.ts";

test("toPersistedCaptureState drops synced and keeps only in-flight seen ids", () => {
	const persisted = toPersistedCaptureState({
		source: "bookmark",
		tweets: { a: { rest_id: "a" }, b: { rest_id: "b" } },
		responses: [],
		seen: ["a", "b", "c", "d"],
		synced: ["c", "d", "e"],
		startedAt: "2026-01-01T00:00:00.000Z",
		pageUrl: "https://x.com/i/bookmarks",
	});
	assert.deepEqual(persisted.seen.sort(), ["a", "b"]);
	assert.deepEqual(persisted.synced, []);
	assert.equal(Object.keys(persisted.tweets).length, 2);
});
