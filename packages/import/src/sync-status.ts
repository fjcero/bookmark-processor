export interface ArticleQueueCounts {
	pending: number;
	fetching: number;
	ok: number;
	failed: number;
	total: number;
}

export interface ArticleQueueEntry {
	tweetId: string;
	articleId: string;
	url: string;
	status: "pending" | "fetching" | "ok" | "failed";
	attempts: number;
	lastError?: string;
	nextAt?: number;
}

export interface ImportWorkerProgress {
	pending: number;
	processingId?: string;
	imported: number;
	skipped: number;
	items?: Array<{
		externalId: string;
		status: "pending" | "processing";
		attempts: number;
		enqueuedAt: number;
		nextAt?: number;
		lastError?: string;
	}>;
	completedIds?: string[];
	importedDelta?: number;
	skippedDelta?: number;
	libraryTotal?: number | null;
	libraryPosts?: number | null;
	libraryArticles?: number | null;
	lastError?: string;
}

export interface ExtensionStatusReport {
	capturedUnsynced: number;
	pendingUpload: boolean;
	pendingUploadCount?: number;
	articles: ArticleQueueCounts;
	articleQueue?: ArticleQueueEntry[];
	importWorker?: ImportWorkerProgress;
	timelineRunning?: boolean;
	timelineCaptured?: number;
	captureScrollActive?: boolean;
	rateLimitedUntil?: number;
	lastError?: string;
	reportedAt: string;
}

export interface LibrarySyncQueue {
	articlesNeedingBody: number;
	articlesRefetchQueued: number;
	captureUnavailable: number;
	importQueue: ImportQueueCounts;
}

export type ImportQueueStatus =
	| "pending"
	| "importing"
	| "imported"
	| "skipped"
	| "failed"
	| "cancelled";

export interface ImportQueueCounts {
	pending: number;
	importing: number;
	imported: number;
	skipped: number;
	failed: number;
	cancelled: number;
	total: number;
}

export interface ImportQueueItemDto {
	id: string;
	source: string;
	kind: string;
	externalId: string;
	status: ImportQueueStatus;
	origin: string;
	lastError: string | null;
	itemId: string | null;
	createdAt: string;
	updatedAt: string;
	preview: string | null;
}

export interface SyncRevocation {
	id: string;
	source: string;
	externalId: string;
	tweetId?: string;
	articleId?: string;
	at: string;
}

export interface SyncStatusResponse {
	library: LibrarySyncQueue;
	extension: ExtensionStatusReport | null;
	extensionOnline: boolean;
	revocations: SyncRevocation[];
}

export const EXTENSION_ONLINE_MS = 2 * 60 * 1000;
