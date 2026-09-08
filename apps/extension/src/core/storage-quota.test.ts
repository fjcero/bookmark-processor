import assert from "node:assert/strict";
import { test } from "node:test";
import { isStorageQuotaError } from "./storage-quota.ts";

test("isStorageQuotaError detects Chrome quota failures", () => {
	assert.equal(
		isStorageQuotaError(Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" })),
		true,
	);
	assert.equal(isStorageQuotaError({ name: "UnknownError", code: 5 }), true);
	assert.equal(isStorageQuotaError({ name: "QuotaExceededError", code: 22 }), true);
	assert.equal(
		isStorageQuotaError({ message: "Internal error: Error code 5" }),
		true,
	);
	assert.equal(isStorageQuotaError(new Error("network failed")), false);
	assert.equal(isStorageQuotaError(null), false);
});
