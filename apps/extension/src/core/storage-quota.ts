export function isStorageQuotaError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const name = "name" in err ? String(err.name) : "";
	const code = "code" in err ? Number(err.code) : Number.NaN;
	const message = "message" in err ? String(err.message) : "";
	return (
		name === "QuotaExceededError" ||
		code === 22 ||
		code === 5 ||
		/quota exceeded|error code 5/i.test(message)
	);
}
