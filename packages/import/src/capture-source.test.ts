import assert from "node:assert/strict";
import { test } from "node:test";
import {
	captureSourceFromPath,
	resolveItemKind,
	shouldPromoteKind,
} from "./capture-source.ts";

test("captureSourceFromPath maps capture pages", () => {
	assert.equal(captureSourceFromPath("/i/bookmarks"), "bookmark");
	assert.equal(captureSourceFromPath("/user/bookmarks"), "bookmark");
	assert.equal(captureSourceFromPath("/user/likes"), "like");
	assert.equal(captureSourceFromPath("/user/with_replies"), "own");
});

test("resolveItemKind remaps legacy history to bookmark", () => {
	assert.equal(resolveItemKind("history"), "bookmark");
	assert.equal(resolveItemKind("own"), "own");
});

test("shouldPromoteKind prefers bookmark over like over own", () => {
	assert.equal(shouldPromoteKind("own", "like"), true);
	assert.equal(shouldPromoteKind("like", "bookmark"), true);
	assert.equal(shouldPromoteKind("bookmark", "like"), false);
	assert.equal(shouldPromoteKind("own", "bookmark"), true);
});
