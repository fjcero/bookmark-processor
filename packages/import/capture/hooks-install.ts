/**
 * Page-context fetch/XHR hooks. Must run in MAIN world (not extension isolated world).
 */

import { enqueueCapture } from "./hooks-events";
import { isSafeArticleReplayUrl, withArticleBodyToggles } from "../src/article-request";

export type CaptureCallback = (
	data: unknown,
	url: string,
	method: string,
	request?: {
		headers: Record<string, string>;
		body?: string;
	},
) => void;

function isApiUrl(u: string): boolean {
	const url = u.toLowerCase();
	return (
		url.includes("/graphql/") ||
		url.includes("/i/api/") ||
		url.includes("/2/timeline") ||
		url.includes("/2/articles") ||
		url.includes("articleentity") ||
		url.includes("api.x.com") ||
		url.includes("api.twitter.com")
	);
}

function shouldParseJson(url: string, contentType: string): boolean {
	if (contentType.includes("json")) return true;
	if (!contentType && isApiUrl(url)) return true;
	return false;
}

function isArticlePage(): boolean {
	try {
		return /\/i\/article\/\d+/.test(location.pathname);
	} catch {
		return false;
	}
}

function rewriteArticleRequest(
	input: RequestInfo | URL,
	init?: RequestInit,
): { input: RequestInfo | URL; init?: RequestInit } {
	if (!isArticlePage()) return { input, init };
	const url = input instanceof Request ? input.url : String(input);
	if (!isSafeArticleReplayUrl(url)) return { input, init };
	const body = typeof init?.body === "string" ? init.body : undefined;
	const rewritten = withArticleBodyToggles(url, body);
	let nextInput: RequestInfo | URL = input;
	if (input instanceof Request) {
		if (rewritten.url !== input.url) {
			nextInput = new Request(rewritten.url, input);
		}
	} else {
		nextInput = rewritten.url;
	}
	const nextInit =
		rewritten.body != null && rewritten.body !== body
			? { ...init, body: rewritten.body }
			: init;
	return { input: nextInput, init: nextInit };
}

function disguiseAsNative<T extends object>(wrapped: T, native: T): T {
	const nativeFn = native as { name?: string; length?: number };
	Object.defineProperty(wrapped, "name", { value: nativeFn.name ?? "fetch" });
	Object.defineProperty(wrapped, "length", { value: nativeFn.length ?? 0 });
	const source = Function.prototype.toString.call(native);
	(wrapped as { toString: () => string }).toString = () => source;
	return wrapped;
}

const REPLAY_HEADERS = new Set([
	"authorization",
	"content-type",
	"x-client-transaction-id",
	"x-csrf-token",
	"x-twitter-active-user",
	"x-twitter-auth-type",
]);

function captureRequest(
	input: RequestInfo | URL,
	init?: RequestInit,
): { headers: Record<string, string>; body?: string } {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	if (init?.headers) {
		new Headers(init.headers).forEach((value, key) => headers.set(key, value));
	}
	const replayHeaders: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (REPLAY_HEADERS.has(key.toLowerCase())) replayHeaders[key] = value;
	});
	return {
		headers: replayHeaders,
		body: typeof init?.body === "string" ? init.body : undefined,
	};
}

export function installCaptureHooks(onData: CaptureCallback): () => void {
	const nativeFetch = window.fetch;
	const origFetch = nativeFetch.bind(window);
	const origOpen = XMLHttpRequest.prototype.open;
	const origSend = XMLHttpRequest.prototype.send;
	const xhrMeta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

	window.fetch = disguiseAsNative(async function (
		input: RequestInfo | URL,
		init?: RequestInit,
	) {
		const rewritten = rewriteArticleRequest(input, init);
		const request = captureRequest(rewritten.input, rewritten.init);
		const r = await origFetch(rewritten.input, rewritten.init);
		try {
			const u =
				rewritten.input instanceof Request
					? rewritten.input.url
					: String(rewritten.input);
			if (isApiUrl(u)) {
				const ct = r.headers.get("content-type") ?? "";
				if (shouldParseJson(u, ct)) {
					const data = await r.clone().json();
					let method = "GET";
					if (rewritten.input instanceof Request) {
						method = rewritten.input.method || "GET";
					} else if (rewritten.init?.method) {
						method = rewritten.init.method;
					}
					onData(data, u, method, request);
				}
			}
		} catch {
			/* ignore */
		}
		return r;
	} as typeof window.fetch, nativeFetch);

	XMLHttpRequest.prototype.open = disguiseAsNative(function (
		this: XMLHttpRequest,
		method: string,
		url: string | URL,
		async?: boolean,
		username?: string | null,
		password?: string | null,
	) {
		xhrMeta.set(this, {
			method: String(method ?? "GET"),
			url: String(url ?? ""),
		});
		return origOpen.call(this, method, url, async ?? true, username, password);
	} as typeof origOpen, origOpen);

	XMLHttpRequest.prototype.send = disguiseAsNative(function (
		this: XMLHttpRequest,
		body?: Document | XMLHttpRequestBodyInit | null,
	) {
		const xhr = this;
		const meta = xhrMeta.get(xhr) ?? { method: "GET", url: "" };
		if (isApiUrl(meta.url)) {
			xhr.addEventListener("load", function () {
				try {
					onData(JSON.parse(xhr.responseText), meta.url, meta.method);
				} catch {
					/* ignore */
				}
			});
		}
		return origSend.call(xhr, body);
	} as typeof origSend, origSend);

	return () => {
		window.fetch = nativeFetch;
		XMLHttpRequest.prototype.open = origOpen;
		XMLHttpRequest.prototype.send = origSend;
	};
}

export function installCaptureHooksWithQueue(): () => void {
	return installCaptureHooks((data, url, method, request) => {
		enqueueCapture({
			url,
			method,
			capturedAt: new Date().toISOString(),
			data,
			request,
		});
	});
}
