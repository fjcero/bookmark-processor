import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, itemRaw, items, settings } from "@repo/db";
import {
	articleRestId,
	articleResultFromTweet,
	type ExtensionStatusReport,
	type LibrarySyncQueue,
	type SyncRevocation,
	type SyncStatusResponse,
	EXTENSION_ONLINE_MS,
} from "@repo/import";
import { createId } from "@/lib/ids";
import { getImportQueueCounts } from "@/lib/import-queue";
import { listedForKind } from "@/lib/item-scope";

const EXTENSION_STATUS_KEY = "extension.status";
const REVOCATIONS_KEY = "sync.revocations";
const MAX_REVOCATIONS = 500;

async function getSetting(key: string): Promise<string | undefined> {
	const [row] = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, key))
		.limit(1);
	return row?.value;
}

async function putSetting(key: string, value: string): Promise<void> {
	await db
		.insert(settings)
		.values({ key, value })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value },
		});
}

function parseRevocations(raw: string | undefined): SyncRevocation[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as SyncRevocation[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function getLibrarySyncQueue(): Promise<LibrarySyncQueue> {
	const [needingBody] = await db
		.select({ n: count() })
		.from(items)
		.leftJoin(
			itemRaw,
			and(
				eq(itemRaw.source, items.source),
				eq(itemRaw.externalId, items.externalId),
			),
		)
		.where(
			and(
				listedForKind("all"),
				eq(items.contentType, "article"),
				isNull(items.captureUnavailableAt),
				sql`(
          json_extract(${itemRaw.payload}, '$.article.article_results.result.content_state.blocks[0].text') IS NULL
          AND json_extract(${itemRaw.payload}, '$._articleRaw') IS NULL
        )`,
			),
		);
	const [refetchQueued] = await db
		.select({ n: count() })
		.from(items)
		.where(and(listedForKind("all"), isNotNull(items.hydrateRequestedAt)));
	const [unavailable] = await db
		.select({ n: count() })
		.from(items)
		.where(and(listedForKind("all"), isNotNull(items.captureUnavailableAt)));

	return {
		articlesNeedingBody: needingBody?.n ?? 0,
		articlesRefetchQueued: refetchQueued?.n ?? 0,
		captureUnavailable: unavailable?.n ?? 0,
		importQueue: await getImportQueueCounts(),
	};
}

export async function saveExtensionStatus(
	report: ExtensionStatusReport,
): Promise<void> {
	await putSetting(EXTENSION_STATUS_KEY, JSON.stringify(report));
}

async function loadExtensionStatus(): Promise<ExtensionStatusReport | null> {
	const raw = await getSetting(EXTENSION_STATUS_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ExtensionStatusReport;
	} catch {
		return null;
	}
}

export async function listPendingRevocations(): Promise<SyncRevocation[]> {
	return parseRevocations(await getSetting(REVOCATIONS_KEY));
}

export async function ackSyncRevocations(ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const pending = await listPendingRevocations();
	const drop = new Set(ids);
	const next = pending.filter((entry) => !drop.has(entry.id));
	await putSetting(REVOCATIONS_KEY, JSON.stringify(next));
}

export async function recordSyncRevocation(input: {
	source: string;
	externalId: string;
	rawJson: string;
	contentType: string;
}): Promise<void> {
	let articleId: string | undefined;
	try {
		const parsed = JSON.parse(input.rawJson) as unknown;
		articleId =
			input.contentType === "article"
				? articleRestId(articleResultFromTweet(parsed)) ?? undefined
				: undefined;
	} catch {
		/* ignore */
	}

	const entry: SyncRevocation = {
		id: createId(),
		source: input.source,
		externalId: input.externalId,
		tweetId: input.externalId,
		articleId,
		at: new Date().toISOString(),
	};

	const pending = await listPendingRevocations();
	pending.push(entry);
	const trimmed = pending.slice(-MAX_REVOCATIONS);
	await putSetting(REVOCATIONS_KEY, JSON.stringify(trimmed));
}

export async function getSyncStatus(): Promise<SyncStatusResponse> {
	const extension = await loadExtensionStatus();
	const extensionOnline =
		extension?.reportedAt != null &&
		Date.now() - Date.parse(extension.reportedAt) < EXTENSION_ONLINE_MS;

	return {
		library: await getLibrarySyncQueue(),
		extension,
		extensionOnline,
		revocations: await listPendingRevocations(),
	};
}
