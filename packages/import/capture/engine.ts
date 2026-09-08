/**
 * Browser capture engine for X bookmark/likes export v2.
 * Shared by bookmarklet, console script, and Chrome extension.
 */

import {
	CAPTURE_EVENT,
	drainCaptureQueue,
	type CaptureEventDetail,
} from "./hooks-events";
import {
	findHydratedArticleResult,
	hasFullArticleBody,
	isRicherArticlePayload,
	mergeArticleIntoTweet,
	stampArticleRaw,
	type GraphQLArticleResult,
} from "../src/article";
import { applySortIndexes } from "../src/sort-index";

export interface CaptureResponse {
	url: string;
	method: string;
	capturedAt: string;
	data: unknown;
}

export interface CaptureState {
	source: "bookmark" | "like" | "history";
	tweets: Record<string, unknown>;
	responses: CaptureResponse[];
	seen: string[];
	startedAt: string;
	pageUrl: string;
}

export interface CaptureStorage {
	load(): Promise<Partial<CaptureState> | null>;
	save(state: CaptureState): Promise<void>;
	clear(): Promise<void>;
}

export interface CaptureEngineOptions {
	storage?: CaptureStorage;
	onCountChange?: (count: number) => void;
	onToast?: (message: string, color?: string) => void;
	onArticleBody?: (article: GraphQLArticleResult, raw: unknown) => void;
	onCapture?: (detail: CaptureEventDetail) => void;
	onTweetObserved?: (tweetId: string) => void;
	persistDebounceMs?: number;
	/** Extension: skip storing raw API responses (saves chrome.storage quota). */
	storeResponses?: boolean;
}

export interface ExportPayload {
	exportVersion: 2;
	exportedAt: string;
	source: "bookmark" | "like" | "history";
	origin: string;
	page: { url: string; pathname: string };
	stats: { tweetCount: number; responseCount: number };
	tweets: Record<string, unknown>;
	responses: CaptureResponse[];
}

const STORAGE_KEY = "x-export-v2-state";

export function createLocalStorageAdapter(): CaptureStorage {
	return {
		async load() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				return raw ? (JSON.parse(raw) as Partial<CaptureState>) : null;
			} catch {
				return null;
			}
		},
		async save(state) {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		},
		async clear() {
			localStorage.removeItem(STORAGE_KEY);
		},
	};
}

export class CaptureEngine {
	readonly source: "bookmark" | "like" | "history";
	readonly label: string;
	private tweets: Record<string, unknown>;
	private responses: CaptureResponse[];
	private seen: Set<string>;
	private readonly storage?: CaptureStorage;
	private readonly onCountChange?: (count: number) => void;
	private readonly onToast?: (message: string, color?: string) => void;
	private readonly onArticleBody?: (article: GraphQLArticleResult, raw: unknown) => void;
	private readonly onCapture?: (detail: CaptureEventDetail) => void;
	private readonly onTweetObserved?: (tweetId: string) => void;
	private readonly observedTweets: Set<string>;
	private persistTimer: ReturnType<typeof setTimeout> | null;
	private readonly persistDebounceMs: number;
	private readonly storeResponses: boolean;
	private startedAt: string;
	private pageListener: ((e: Event) => void) | null;
	private active: boolean;

	constructor(options: CaptureEngineOptions = {}) {
		const path = location.pathname;
		const isLikes = path.includes("/likes");
		const isHistory = path.includes("/history");
		this.tweets = {};
		this.responses = [];
		this.seen = new Set();
		this.observedTweets = new Set();
		this.persistTimer = null;
		this.startedAt = new Date().toISOString();
		this.pageListener = null;
		this.active = false;
		this.source = isLikes ? "like" : isHistory ? "history" : "bookmark";
		this.label = isLikes ? "likes" : isHistory ? "history" : "bookmarks";
		this.storage = options.storage;
		this.onCountChange = options.onCountChange;
		this.onToast = options.onToast;
		this.onArticleBody = options.onArticleBody;
		this.onCapture = options.onCapture;
		this.onTweetObserved = options.onTweetObserved;
		this.persistDebounceMs = options.persistDebounceMs ?? 500;
		this.storeResponses = options.storeResponses ?? true;
	}

	tweetCount(): number {
		return Object.keys(this.tweets).length;
	}

	async restore(): Promise<boolean> {
		if (!this.storage) return false;
		const saved = await this.storage.load();
		if (!saved?.tweets) return false;
		this.tweets = saved.tweets;
		this.responses = saved.responses ?? [];
		this.seen = new Set(saved.seen ?? Object.keys(saved.tweets));
		this.startedAt = saved.startedAt ?? this.startedAt;
		this.onCountChange?.(this.tweetCount());
		return this.tweetCount() > 0;
	}

	start(): void {
		if (this.active) return;
		this.active = true;

		for (const item of drainCaptureQueue()) {
			this.ingest(item);
		}
		this.pageListener = (e: Event) => {
			const detail = (e as CustomEvent<CaptureEventDetail>).detail;
			if (detail) this.ingest(detail);
		};
		document.addEventListener(CAPTURE_EVENT, this.pageListener);
	}

	stop(): void {
		if (!this.active) return;
		this.active = false;
		if (this.pageListener) {
			document.removeEventListener(CAPTURE_EVENT, this.pageListener);
			this.pageListener = null;
		}
	}

	ingest(detail: CaptureEventDetail): void {
		this.onCapture?.(detail);
		this.processData(detail.data, detail.url, detail.method, detail.capturedAt);
	}

	buildPayload(): ExportPayload {
		return {
			exportVersion: 2,
			exportedAt: new Date().toISOString(),
			source: this.source,
			origin: "x-bookmark-export-v2",
			page: { url: location.href, pathname: location.pathname },
			stats: {
				tweetCount: this.tweetCount(),
				responseCount: this.responses.length,
			},
			tweets: this.tweets,
			responses: this.responses,
		};
	}

	async clearPersisted(): Promise<void> {
		await this.storage?.clear();
	}

	/** Remove tweets that were included in a successful upload. */
	removeSynced(ids: string[]): void {
		if (ids.length === 0) return;
		this.clearPersistTimer();
		for (const id of ids) {
			delete this.tweets[id];
		}
		this.schedulePersist();
		this.onCountChange?.(this.tweetCount());
	}

	/** Clear captured data after a successful export; capture keeps running. */
	async reset(): Promise<void> {
		this.clearPersistTimer();
		this.tweets = {};
		this.responses = [];
		this.seen = new Set();
		this.startedAt = new Date().toISOString();
		await this.clearPersisted();
		this.onCountChange?.(0);
	}

	private clearPersistTimer(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
	}

	private schedulePersist(): void {
		if (!this.storage) return;
		this.clearPersistTimer();
		this.persistTimer = setTimeout(() => {
			void this.storage
				?.save({
					source: this.source,
					tweets: this.tweets,
					responses: this.storeResponses ? this.responses : [],
					seen: [...this.seen],
					startedAt: this.startedAt,
					pageUrl: location.href,
				})
				.catch(() => {
					/* storage quota / dead extension context */
				});
		}, this.persistDebounceMs);
	}

	private addTweet(t: unknown): void {
		const tweet = this.unwrapTweet(t) as { rest_id?: string } | null;
		if (!tweet?.rest_id) return;
		const id = tweet.rest_id;
		if (!this.observedTweets.has(id)) {
			this.observedTweets.add(id);
			this.onTweetObserved?.(id);
		}
		if (this.seen.has(id)) {
			const existing = this.tweets[id];
			if (isRicherArticlePayload(tweet, existing)) {
				const article = findHydratedArticleResult(tweet);
				this.tweets[id] = article
					? mergeArticleIntoTweet(existing, article)
					: tweet;
				this.onCountChange?.(this.tweetCount());
				this.schedulePersist();
			}
			return;
		}
		this.seen.add(id);
		this.tweets[id] = tweet;
		this.onCountChange?.(this.tweetCount());
		this.schedulePersist();
	}

	private isTweetObj(o: unknown): boolean {
		if (!o || typeof o !== "object") return false;
		const obj = o as { rest_id?: string; legacy?: unknown; core?: unknown };
		return (
			typeof obj.rest_id === "string" &&
			obj.rest_id.length > 5 &&
			(obj.legacy != null || obj.core != null)
		);
	}

	private unwrapTweet(t: unknown): unknown {
		if (!t || typeof t !== "object") return null;
		const obj = t as {
			__typename?: string;
			tweet?: unknown;
		};
		if (
			obj.__typename === "TweetWithVisibilityResults" ||
			obj.__typename === "TweetWithVisibilityResult"
		) {
			return obj.tweet ?? t;
		}
		return t;
	}

	private deepFindTweets(obj: unknown, depth = 0): void {
		if (!obj || typeof obj !== "object" || depth > 12) return;
		if (Array.isArray(obj)) {
			for (const item of obj) this.deepFindTweets(item, depth + 1);
			return;
		}
		const record = obj as Record<string, unknown>;
		if (record.tweet_results && typeof record.tweet_results === "object") {
			const results = record.tweet_results as { result?: unknown };
			const tw = this.unwrapTweet(results.result);
			if (tw) this.addTweet(tw);
		} else if (this.isTweetObj(obj)) {
			this.addTweet(this.unwrapTweet(obj));
		}
		for (const k of Object.keys(record)) {
			if (k !== "quoted_status_result") {
				this.deepFindTweets(record[k], depth + 1);
			}
		}
	}

	private processData(
		d: unknown,
		url: string,
		method: string,
		capturedAt?: string,
	): void {
		if (this.storeResponses) {
			this.responses.push({
				url: url || "",
				method: method || "GET",
				capturedAt: capturedAt ?? new Date().toISOString(),
				data: d,
			});
		}
		this.deepFindTweets(d, 0);
		applySortIndexes(this.tweets, d);
		const hydrated = findHydratedArticleResult(d);
		if (hydrated && hasFullArticleBody(hydrated)) {
			this.onArticleBody?.(hydrated, d);
		}
		this.schedulePersist();
	}
}

export function downloadPayload(payload: ExportPayload): void {
	const blob = new Blob([JSON.stringify(payload, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${payload.source}s.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function uploadPayload(
	payload: ExportPayload,
	serverUrl: string,
): Promise<{
	imported: number;
	skipped: number;
	total: number | null;
	error?: string;
}> {
	const base = serverUrl.replace(/\/$/, "");
	const res = await fetch(`${base}/api/import/capture`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const data = (await res.json()) as {
		error?: string;
		items?: { imported: number; skipped: number };
		total?: number;
	};
	if (!res.ok) {
		throw new Error(data.error ?? `Upload failed (${res.status})`);
	}
	return {
		imported: data.items?.imported ?? 0,
		skipped: data.items?.skipped ?? 0,
		total: typeof data.total === "number" ? data.total : null,
	};
}

export async function fetchServerTotal(serverUrl: string): Promise<number> {
	const base = serverUrl.replace(/\/$/, "");
	const res = await fetch(`${base}/api/import/capture`);
	if (!res.ok) throw new Error(`Stats failed (${res.status})`);
	const data = (await res.json()) as { total?: number };
	if (typeof data.total !== "number") {
		throw new Error("Stats response is missing total");
	}
	return data.total;
}

export async function fetchPendingArticles(
	serverUrl: string,
	limit = 40,
): Promise<
	Array<{ tweetId: string; articleId: string; url: string; refetch?: boolean }>
> {
	const base = serverUrl.replace(/\/$/, "");
	const res = await fetch(
		`${base}/api/import/articles/pending?limit=${limit}`,
	);
	if (!res.ok) throw new Error(`Pending articles failed (${res.status})`);
	const data = (await res.json()) as {
		articles?: Array<{
			tweetId: string;
			articleId: string;
			url: string;
			refetch?: boolean;
		}>;
	};
	return Array.isArray(data.articles) ? data.articles : [];
}

export async function archiveUnavailableArticle(
	serverUrl: string,
	externalId: string,
	source = "x",
): Promise<boolean> {
	const base = serverUrl.replace(/\/$/, "");
	const res = await fetch(`${base}/api/import/articles/unavailable`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source, externalId }),
	});
	if (!res.ok) return false;
	const data = (await res.json()) as { archived?: boolean; kept?: boolean };
	return data.kept === true || data.archived === true;
}

export function buildArticleHydrationPayload(
	tweetId: string,
	article: GraphQLArticleResult,
	source: ExportPayload["source"] = "bookmark",
	pageUrl = "",
	raw?: unknown,
): ExportPayload {
	let pathname = `/i/article/${article.rest_id ?? ""}`;
	try {
		if (pageUrl) pathname = new URL(pageUrl).pathname;
	} catch {
		/* keep default */
	}
	const tweet = stampArticleRaw(
		mergeArticleIntoTweet(
			{ __typename: "Tweet", rest_id: tweetId },
			article,
		),
		raw,
	);
	return {
		exportVersion: 2,
		exportedAt: new Date().toISOString(),
		source,
		origin: "x-article-hydrate",
		page: { url: pageUrl, pathname },
		stats: { tweetCount: 1, responseCount: raw != null ? 1 : 0 },
		tweets: { [tweetId]: tweet },
		responses:
			raw != null
				? [
						{
							url: pageUrl,
							method: "GET",
							capturedAt: new Date().toISOString(),
							data: raw,
						},
					]
				: [],
	};
}

export interface AutoScrollOptions {
	/** Pause between scroll steps (ms). */
	scrollDelayMs?: number;
	/** Called when scroll stops producing new tweets; return true after recovery action. */
	onStagnant?: () => Promise<boolean>;
}

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export async function runAutoScroll(
	engine: CaptureEngine,
	onProgress: (count: number, done: boolean) => void,
	shouldContinue: () => boolean,
	options: AutoScrollOptions = {},
): Promise<void> {
	const scrollDelayMs = options.scrollDelayMs ?? 300;
	let stagnant = 0;
	let lastCount = engine.tweetCount();
	while (shouldContinue()) {
		window.scrollTo(0, document.documentElement.scrollHeight);
		const col = document.querySelector('[data-testid="primaryColumn"]');
		col?.scrollTo(0, col.scrollHeight);
		await sleep(scrollDelayMs);
		const count = engine.tweetCount();
		if (count > lastCount) {
			stagnant = 0;
			lastCount = count;
			onProgress(count, false);
		} else {
			stagnant++;
			if (options.onStagnant) {
				const recovered = await options.onStagnant();
				if (recovered) {
					stagnant = 0;
					await sleep(2000);
					continue;
				}
			}
			if (stagnant >= 8) {
				window.scrollTo(0, document.documentElement.scrollHeight);
				await sleep(2000);
				if (options.onStagnant) {
					const recovered = await options.onStagnant();
					if (recovered) {
						stagnant = 0;
						continue;
					}
				}
				if (engine.tweetCount() === lastCount) {
					onProgress(engine.tweetCount(), true);
					return;
				}
				stagnant = 0;
			}
		}
	}
	onProgress(engine.tweetCount(), false);
}
