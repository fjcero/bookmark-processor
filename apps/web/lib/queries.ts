import {
	and,
	count,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	sql,
	type SQL,
} from "drizzle-orm";
import { categories, db, itemCategories, items, users } from "@repo/db";
import { articleResultFromTweet } from "@repo/import";
import {
	derivePostFormat,
	findHydratedArticleResult,
	hasCompleteArticleRaw,
	isPendingArticleRaw,
	parseArticleContent,
	pendingArticleFromRaw,
	type ContentType,
	type ParsedArticleContent,
	type PostFormat,
} from "@repo/import";
import { recordSyncRevocation } from "@/lib/sync-status";
import { extractEmbeds, type EmbeddedTweet } from "./embeds";
import { mediaUrlsForItem } from "./entities";
import {
	buildItemSearchWhere,
	type ItemSearchFilters,
} from "./item-search";
import { DEFAULT_ITEM_SORT, type ItemSort } from "./import-prefs";

const listed = isNull(items.archivedAt);

export interface StageCounts {
	done: number;
	pending: number;
}

export interface BucketStats {
	total: number;
	entities: StageCounts;
	understanding: StageCounts;
	categorized: StageCounts;
}

export interface Stats {
	users: number;
	items: number;
	archived: number;
	posts: BucketStats;
	articles: BucketStats;
	entities: StageCounts;
	understanding: StageCounts;
	categorized: StageCounts;
}

export interface ItemRow {
	id: string;
	source: string;
	externalId: string;
	text: string;
	kind: string;
	contentType: ContentType;
	postFormat: PostFormat;
	articleHydrated: boolean;
	articleRefetching: boolean;
	articleTitle: string | null;
	articlePreview: string | null;
	articleContent: ParsedArticleContent | null;
	publishedAt: Date | null;
	url: string | null;
	sortIndex: string | null;
	importedAt: Date;
	categorizedAt: Date | null;
	understanding: string | null;
	entities: string | null;
	mediaUrls: string[];
	embeds: EmbeddedTweet[];
	handle: string;
	name: string;
	avatarUrl: string | null;
	categories: {
		slug: string;
		name: string;
		color: string;
		confidence: number;
	}[];
}

function asCount(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function emptyBucket(): BucketStats {
	return {
		total: 0,
		entities: { done: 0, pending: 0 },
		understanding: { done: 0, pending: 0 },
		categorized: { done: 0, pending: 0 },
	};
}

function bucketFromCounts(
	total: number,
	entitiesDone: number,
	understandingDone: number,
	categorizedDone: number,
): BucketStats {
	return {
		total,
		entities: { done: entitiesDone, pending: total - entitiesDone },
		understanding: {
			done: understandingDone,
			pending: total - understandingDone,
		},
		categorized: { done: categorizedDone, pending: total - categorizedDone },
	};
}

function mergeBuckets(a: BucketStats, b: BucketStats): BucketStats {
	return bucketFromCounts(
		a.total + b.total,
		a.entities.done + b.entities.done,
		a.understanding.done + b.understanding.done,
		a.categorized.done + b.categorized.done,
	);
}

export async function getStats(): Promise<Stats> {
	const [archived] = await db
		.select({ n: count() })
		.from(items)
		.where(isNotNull(items.archivedAt));
	const [userCount] = await db.select({ n: count() }).from(users);
	const buckets = await db
		.select({
			contentType: items.contentType,
			n: count(),
			entities: sql<number>`sum(case when ${items.entities} is not null then 1 else 0 end)`,
			understanding: sql<number>`sum(case when ${items.understanding} is not null then 1 else 0 end)`,
			categorized: sql<number>`sum(case when ${items.categorizedAt} is not null then 1 else 0 end)`,
		})
		.from(items)
		.where(listed)
		.groupBy(items.contentType);

	let posts = emptyBucket();
	let articles = emptyBucket();
	for (const row of buckets) {
		const next = bucketFromCounts(
			asCount(row.n),
			asCount(row.entities),
			asCount(row.understanding),
			asCount(row.categorized),
		);
		if (row.contentType === "article") articles = next;
		else posts = mergeBuckets(posts, next);
	}
	const all = mergeBuckets(posts, articles);

	return {
		users: userCount.n,
		items: all.total,
		archived: archived.n,
		posts,
		articles,
		entities: all.entities,
		understanding: all.understanding,
		categorized: all.categorized,
	};
}

export interface ListItemsParams {
	limit?: number;
	offset?: number;
	uncategorized?: boolean;
	search?: ItemSearchFilters;
	sort?: ItemSort;
}

export interface ListItemsResult {
	items: ItemRow[];
	total: number;
}

type RawItemRow = {
	id: string;
	source: string;
	externalId: string;
	text: string;
	kind: string;
	contentType: string;
	publishedAt: Date | null;
	url: string | null;
	sortIndex: string | null;
	importedAt: Date;
	categorizedAt: Date | null;
	understanding: string | null;
	entities: string | null;
	rawJson: string;
	hydrateRequestedAt: Date | null;
	handle: string;
	name: string;
	avatarUrl: string | null;
};

const itemSelect = {
	id: items.id,
	source: items.source,
	externalId: items.externalId,
	text: items.text,
	kind: items.kind,
	contentType: items.contentType,
	publishedAt: items.publishedAt,
	url: items.url,
	sortIndex: items.sortIndex,
	importedAt: items.importedAt,
	categorizedAt: items.categorizedAt,
	understanding: items.understanding,
	entities: items.entities,
	rawJson: items.rawJson,
	hydrateRequestedAt: items.hydrateRequestedAt,
	handle: users.handle,
	name: users.name,
	avatarUrl: users.avatarUrl,
};

function listWhere(
	uncategorized: boolean,
	search?: ItemSearchFilters,
): SQL | undefined {
	const parts: SQL[] = [listed];
	if (uncategorized) parts.push(isNull(items.categorizedAt));
	const searchWhere = buildItemSearchWhere(search ?? {});
	if (searchWhere) parts.push(searchWhere);
	return and(...parts);
}

async function loadCategories(
	itemIds: string[],
): Promise<Map<string, ItemRow["categories"]>> {
	const catRows =
		itemIds.length === 0
			? []
			: await db
					.select({
						itemId: itemCategories.itemId,
						slug: categories.slug,
						name: categories.name,
						color: categories.color,
						confidence: itemCategories.confidence,
					})
					.from(itemCategories)
					.innerJoin(categories, eq(itemCategories.categoryId, categories.id))
					.where(inArray(itemCategories.itemId, itemIds));

	const catsByItem = new Map<string, ItemRow["categories"]>();
	for (const row of catRows) {
		const list = catsByItem.get(row.itemId) ?? [];
		list.push({
			slug: row.slug,
			name: row.name,
			color: row.color,
			confidence: row.confidence,
		});
		catsByItem.set(row.itemId, list);
	}
	return catsByItem;
}

function mapItemRows(
	rows: RawItemRow[],
	catsByItem: Map<string, ItemRow["categories"]>,
): ItemRow[] {
	return rows.map((r) => {
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(r.rawJson);
		} catch {
			parsed = null;
		}
		const article =
			articleResultFromTweet(parsed) ?? findHydratedArticleResult(parsed);
		const contentType = (r.contentType as ContentType) || "post";
		return {
			id: r.id,
			source: r.source,
			externalId: r.externalId,
			text: r.text,
			kind: r.kind,
			contentType,
			postFormat: derivePostFormat(parsed),
			articleHydrated: hasCompleteArticleRaw(parsed),
			articleRefetching: r.hydrateRequestedAt != null,
			articleTitle: article?.title?.trim() || null,
			articlePreview: article?.preview_text?.trim() || null,
			articleContent:
				contentType === "article" ? parseArticleContent(article) : null,
			publishedAt: r.publishedAt,
			url: r.url,
			sortIndex: r.sortIndex,
			importedAt: r.importedAt,
			categorizedAt: r.categorizedAt,
			understanding: r.understanding,
			entities: r.entities,
			mediaUrls: mediaUrlsForItem(r.entities, r.rawJson),
			embeds: extractEmbeds(r.rawJson, r.source),
			handle: r.handle,
			name: r.name,
			avatarUrl: r.avatarUrl,
			categories: catsByItem.get(r.id) ?? [],
		};
	});
}

function itemOrder(sort: ItemSort): SQL[] {
	const published = sql`coalesce(${items.publishedAt}, ${items.importedAt})`;
	if (sort === "imported") {
		return [desc(items.importedAt), desc(published)];
	}
	if (sort === "saved") {
		return [
			sql`length(${items.sortIndex}) DESC`,
			desc(items.sortIndex),
			desc(items.importedAt),
			desc(published),
		];
	}
	return [desc(published)];
}

export async function listItems({
	limit = 40,
	offset = 0,
	uncategorized = false,
	search,
	sort = DEFAULT_ITEM_SORT,
}: ListItemsParams = {}): Promise<ListItemsResult> {
	const where = listWhere(uncategorized, search);
	const baseQuery = db
		.select(itemSelect)
		.from(items)
		.innerJoin(users, eq(items.authorId, users.id))
		.where(where)
		.orderBy(...itemOrder(sort));

	const rows = await baseQuery.limit(limit).offset(offset);
	const [{ n: total }] = await db
		.select({ n: count() })
		.from(items)
		.innerJoin(users, eq(items.authorId, users.id))
		.where(where);

	const catsByItem = await loadCategories(rows.map((r) => r.id));
	return {
		items: mapItemRows(rows, catsByItem),
		total: total,
	};
}

export async function getItems(
	limit = 40,
	offset = 0,
	uncategorized = false,
	sort: ItemSort = DEFAULT_ITEM_SORT,
): Promise<ItemRow[]> {
	const { items: rows } = await listItems({ limit, offset, uncategorized, sort });
	return rows;
}

export async function getItem(id: string): Promise<ItemRow | null> {
	if (!id) return null;
	const rows = await db
		.select(itemSelect)
		.from(items)
		.innerJoin(users, eq(items.authorId, users.id))
		.where(and(eq(items.id, id), listed))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	const catsByItem = await loadCategories([row.id]);
	return mapItemRows([row], catsByItem)[0] ?? null;
}

export interface PendingArticle {
	tweetId: string;
	articleId: string;
	url: string;
	refetch?: boolean;
}

const pendingArticleSelect = {
	id: items.id,
	externalId: items.externalId,
	rawJson: items.rawJson,
	url: items.url,
	hydrateRequestedAt: items.hydrateRequestedAt,
};

function pendingFromRow(
	row: {
		externalId: string;
		rawJson: string;
		url: string | null;
		hydrateRequestedAt: Date | null;
	},
	forceRefetch = false,
): PendingArticle | null {
	const refetch = forceRefetch || row.hydrateRequestedAt != null;
	return pendingArticleFromRaw(row.externalId, row.rawJson, row.url, {
		refetch,
	});
}

export async function getPendingArticles(limit = 40): Promise<PendingArticle[]> {
	const cap = Math.max(limit, 1);
	const refetchRows = await db
		.select(pendingArticleSelect)
		.from(items)
		.where(
			and(
				listed,
				eq(items.contentType, "article"),
				isNotNull(items.hydrateRequestedAt),
			),
		)
		.orderBy(desc(items.hydrateRequestedAt), items.id)
		.limit(cap);

	const pending: PendingArticle[] = [];
	const seen = new Set<string>();
	const completed: string[] = [];
	for (const row of refetchRows) {
		const item = pendingFromRow(row, true);
		if (!item) {
			completed.push(row.id);
			continue;
		}
		if (seen.has(item.articleId)) continue;
		pending.push(item);
		seen.add(item.articleId);
		if (pending.length >= cap) break;
	}
	if (completed.length > 0) {
		await db
			.update(items)
			.set({ hydrateRequestedAt: null })
			.where(inArray(items.id, completed));
	}
	if (pending.length >= cap) return pending;
	if (pending.length > 0) return pending;

	const rows = await db
		.select(pendingArticleSelect)
		.from(items)
		.where(
			and(
				listed,
				eq(items.contentType, "article"),
				isNull(items.captureUnavailableAt),
			),
		)
		.orderBy(items.id)
		.limit(Math.max(cap * 4, 40));

	for (const row of rows) {
		const item = pendingFromRow(row);
		if (!item || seen.has(item.articleId)) continue;
		pending.push(item);
		seen.add(item.articleId);
		if (pending.length >= cap) break;
	}
	return pending;
}

export async function requestArticleRefetch(opts: {
	itemIds?: string[];
	all?: boolean;
}): Promise<{ queued: number }> {
	const now = new Date();
	const itemIds = opts.itemIds?.filter((id) => id.length > 0);

	if (itemIds && itemIds.length > 0) {
		const rows = await db
			.select({
				id: items.id,
				rawJson: items.rawJson,
				contentType: items.contentType,
			})
			.from(items)
			.where(
				and(
					listed,
					eq(items.contentType, "article"),
					inArray(items.id, itemIds),
				),
			);
		const ids = rows
			.filter((row) => isPendingArticleRaw(row.rawJson, row.contentType))
			.map((row) => row.id);
		if (ids.length === 0) return { queued: 0 };
		await db
			.update(items)
			.set({ hydrateRequestedAt: now, captureUnavailableAt: null })
			.where(inArray(items.id, ids));
		return { queued: ids.length };
	}

	if (opts.all) {
		const rows = await db
			.select({
				id: items.id,
				rawJson: items.rawJson,
				contentType: items.contentType,
			})
			.from(items)
			.where(and(listed, eq(items.contentType, "article")));
		const ids = rows
			.filter((row) => isPendingArticleRaw(row.rawJson, row.contentType))
			.map((row) => row.id);
		if (ids.length === 0) return { queued: 0 };
		const CHUNK = 400;
		for (let i = 0; i < ids.length; i += CHUNK) {
			await db
				.update(items)
				.set({ hydrateRequestedAt: now, captureUnavailableAt: null })
				.where(inArray(items.id, ids.slice(i, i + CHUNK)));
		}
		return { queued: ids.length };
	}

	const rows = await db
		.select({
			id: items.id,
			rawJson: items.rawJson,
			contentType: items.contentType,
		})
		.from(items)
		.where(and(listed, eq(items.contentType, "article")));

	const ids: string[] = [];
	for (const row of rows) {
		if (isPendingArticleRaw(row.rawJson, row.contentType)) ids.push(row.id);
	}
	if (ids.length === 0) return { queued: 0 };
	const CHUNK = 400;
	for (let i = 0; i < ids.length; i += CHUNK) {
		await db
			.update(items)
			.set({ hydrateRequestedAt: now, captureUnavailableAt: null })
			.where(inArray(items.id, ids.slice(i, i + CHUNK)));
	}
	return { queued: ids.length };
}

export async function archiveItem(id: string): Promise<boolean> {
	const [row] = await db
		.select({
			id: items.id,
			archivedAt: items.archivedAt,
			source: items.source,
			externalId: items.externalId,
			rawJson: items.rawJson,
			contentType: items.contentType,
		})
		.from(items)
		.where(eq(items.id, id))
		.limit(1);
	if (!row) return false;
	if (row.archivedAt) return true;
	const now = new Date();
	await db.update(items).set({ archivedAt: now }).where(eq(items.id, id));
	await recordSyncRevocation({
		source: row.source,
		externalId: row.externalId,
		rawJson: row.rawJson,
		contentType: row.contentType,
	});
	return true;
}

export async function archiveItemByExternalId(
	source: string,
	externalId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: items.id })
		.from(items)
		.where(
			and(
				eq(items.source, source),
				eq(items.externalId, externalId),
				isNull(items.archivedAt),
			),
		)
		.limit(1);
	if (!row) return false;
	return archiveItem(row.id);
}

/** X no longer has this item. Keep the saved row and stop auto-hydration. */
export async function noteCaptureUnavailable(
	source: string,
	externalId: string,
): Promise<{ kept: boolean }> {
	const [row] = await db
		.select({ id: items.id })
		.from(items)
		.where(
			and(eq(items.source, source), eq(items.externalId, externalId)),
		)
		.limit(1);
	if (!row) return { kept: false };
	await db
		.update(items)
		.set({
			hydrateRequestedAt: null,
			captureUnavailableAt: new Date(),
		})
		.where(eq(items.id, row.id));
	return { kept: true };
}
