import type { NextRequest } from "next/server";

const ALLOWED_ORIGINS = new Set(["https://x.com", "https://twitter.com"]);

export function captureCorsHeaders(request: NextRequest): Record<string, string> {
	const origin = request.headers.get("Origin") ?? "";
	const allowed =
		ALLOWED_ORIGINS.has(origin) ||
		origin.startsWith("chrome-extension://")
			? origin
			: "https://x.com";
	return {
		"Access-Control-Allow-Origin": allowed,
		"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		Vary: "Origin",
	};
}
