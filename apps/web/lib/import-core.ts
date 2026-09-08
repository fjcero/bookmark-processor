import { and, eq, inArray, sql } from "drizzle-orm";
import {
	articlePlainText,
	articleRawFrom,
	articleResultFromTweet,
	articleRestId,
	articleUrl,
	findHydratedArticleResult,
	hasArticleBody,
	hasFullArticleBody,
	isRicherArticlePayload,
	isRicherTweetPayload,
	mergeArticleIntoTweet,
	parseExportV2,
	compareSortIndex,
	stampArticleRaw,
} from "@repo/import";
import { db, imports, items, users } from "@repo/db";
import { createId } from "@/lib/ids";
import {
	markImportQueueImporting,
	resolveImportQueueForExternalIds,
} from "@/lib/import-queue";

export interface ImportResult {
	filename: string;
	parsed: { users: number; items: number };
	users: { imported: number; skipped: number };
	items: { imported: number; skipped: number };
	affectedItemIds: string[];
	error?: string;
}

export async function importExportJson(
	text: string,
	filename: string,
	now = new Date(),
): Promise<ImportResult> {
	let parsed;
	try {
		parsed = parseExportV2(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Failed to parse export";
		return {
			filename,
			parsed: { users: 0, items: 0 },
			users: { imported: 0, skipped: 0 },
			items: { imported: 0, skipped: 0 },
			affectedItemIds: [],
			error: msg,
		};
	}

	const userIds = parsed.users.map((u) => u.id);
	const existingUsers =
		userIds.length > 0
			? await db
					.select({ id: users.id })
					.from(users)
					.where(inArray(users.id, userIds))
			: [];
	const existingUserIds = new Set(existingUsers.map((u) => u.id));

	if (parsed.users.length > 0) {
		const CHUNK = 200;
		for (let i = 0; i < parsed.users.length; i += CHUNK) {
			const slice = parsed.users.slice(i, i + CHUNK);
			await db
				.insert(users)
				.values(
					slice.map((u) => ({
						id: u.id,
						handle: u.handle,
						name: u.name,
						avatarUrl: u.avatarUrl,
						updatedAt: now,
					})),
				)
				.onConflictDoUpdate({
					target: users.id,
					set: {
						handle: sql`excluded.handle`,
						name: sql`excluded.name`,
						avatarUrl: sql`excluded.avatar_url`,
						updatedAt: now,
					},
				});
		}
	}

	const externalIds = parsed.items.map((t) => t.id);
	const source = parsed.items[0]?.source ?? "x";
	await markImportQueueImporting(source, externalIds);
	const existingItems =
		externalIds.length > 0
			? await db
					.select({
						externalId: items.externalId,
						kind: items.kind,
						rawJson: items.rawJson,
						sortIndex: items.sortIndex,
						hydrateRequestedAt: items.hydrateRequestedAt,
					})
					.from(items)
					.where(
						and(
							eq(items.source, source),
							inArray(items.externalId, externalIds),
						),
					)
			: [];
	const existingByExternalId = new Map(
		existingItems.map((i) => [i.externalId, i]),
	);

	const newItems = parsed.items.filter(
		(t) => Boolean(t.authorId) && !existingByExternalId.has(t.id),
	);
	const kindUpdates = parsed.items.filter((t) => {
		const existing = existingByExternalId.get(t.id);
		return existing != null && existing.kind !== t.kind;
	});
	const articleUpdates = parsed.items.filter((t) => {
		const existing = existingByExternalId.get(t.id);
		if (!existing) return false;
		try {
			return isRicherArticlePayload(
				JSON.parse(t.rawJson),
				JSON.parse(existing.rawJson),
			);
		} catch {
			return false;
		}
	});
	const richerTweetUpdates = parsed.items.filter((t) => {
		const existing = existingByExternalId.get(t.id);
		if (!existing || !t.authorId) return false;
		// Article body upgrades are handled separately (merge, not replace).
		if (articleUpdates.some((a) => a.id === t.id)) return false;
		try {
			return isRicherTweetPayload(
				JSON.parse(t.rawJson),
				JSON.parse(existing.rawJson),
			);
		} catch {
			return false;
		}
	});

	if (newItems.length > 0) {
		const CHUNK = 200;
		for (let i = 0; i < newItems.length; i += CHUNK) {
			const slice = newItems.slice(i, i + CHUNK);
			await db
				.insert(items)
				.values(
					slice.map((t) => ({
						id: createId(),
						source: t.source,
						externalId: t.id,
						authorId: t.authorId,
						text: t.text,
						publishedAt: t.createdAt,
						kind: t.kind,
						contentType: t.contentType,
						url: t.url,
						sortIndex: t.sortIndex,
						rawJson: t.rawJson,
						importedAt: now,
					})),
				)
				.onConflictDoNothing({ target: [items.source, items.externalId] });
		}
	}

	const sortIndexUpdates = parsed.items.filter((t) => {
		const existing = existingByExternalId.get(t.id);
		if (!existing || t.sortIndex == null) return false;
		if (existing.sortIndex == null) return true;
		return compareSortIndex(t.sortIndex, existing.sortIndex) > 0;
	});

	for (const item of sortIndexUpdates) {
		await db
			.update(items)
			.set({ sortIndex: item.sortIndex })
			.where(
				and(eq(items.source, source), eq(items.externalId, item.id)),
			);
	}

	for (const item of kindUpdates) {
		await db
			.update(items)
			.set({ kind: item.kind, importedAt: now })
			.where(
				and(eq(items.source, source), eq(items.externalId, item.id)),
			);
	}

	for (const item of richerTweetUpdates) {
		await db
			.update(items)
			.set({
				rawJson: item.rawJson,
				text: item.text,
				publishedAt: item.createdAt,
				kind: item.kind,
				contentType: item.contentType,
				url: item.url,
				sortIndex: item.sortIndex ?? existingByExternalId.get(item.id)?.sortIndex,
				authorId: item.authorId,
				entities: null,
				importedAt: now,
			})
			.where(and(eq(items.source, source), eq(items.externalId, item.id)));
	}

	for (const item of articleUpdates) {
		const existing = existingByExternalId.get(item.id);
		if (!existing) continue;
		let existingTweet: unknown;
		let incomingTweet: unknown;
		try {
			existingTweet = JSON.parse(existing.rawJson);
			incomingTweet = JSON.parse(item.rawJson);
		} catch {
			continue;
		}
		const incomingRaw = articleRawFrom(incomingTweet);
		const incomingArticle =
			articleResultFromTweet(incomingTweet) ??
			findHydratedArticleResult(incomingTweet);
		if (
			(!incomingArticle || !hasArticleBody(incomingArticle)) &&
			incomingRaw == null
		) {
			continue;
		}
		const merged = stampArticleRaw(
			incomingArticle && hasArticleBody(incomingArticle)
				? mergeArticleIntoTweet(existingTweet, incomingArticle)
				: existingTweet,
			incomingRaw,
		);
		const mergedArticle =
			findHydratedArticleResult(merged) ??
			articleResultFromTweet(merged) ??
			incomingArticle;
		const articleId = articleRestId(mergedArticle);
		const full = hasFullArticleBody(
			mergedArticle ?? findHydratedArticleResult(merged),
		);
		await db
			.update(items)
			.set({
				rawJson: JSON.stringify(merged),
				text: mergedArticle
					? articlePlainText(mergedArticle)
					: item.text,
				contentType: "article",
				url: articleId ? articleUrl(articleId) : item.url,
				hydrateRequestedAt: full ? null : existing.hydrateRequestedAt,
				captureUnavailableAt: null,
				importedAt: now,
			})
			.where(and(eq(items.source, source), eq(items.externalId, item.id)));
	}

	const refetchIds = parsed.items
		.filter((item) => {
			if (existingByExternalId.get(item.id)?.hydrateRequestedAt == null) {
				return false;
			}
			try {
				const incoming = JSON.parse(item.rawJson) as unknown;
				const article =
					findHydratedArticleResult(incoming) ??
					articleResultFromTweet(incoming);
				return article != null && hasFullArticleBody(article);
			} catch {
				return false;
			}
		})
		.map((item) => item.id);
	if (refetchIds.length > 0) {
		await db
			.update(items)
			.set({ hydrateRequestedAt: null })
			.where(
				and(eq(items.source, source), inArray(items.externalId, refetchIds)),
			);
	}

	const usersImported = parsed.users.filter(
		(u) => !existingUserIds.has(u.id),
	).length;
	const usersSkipped = parsed.users.length - usersImported;
	// "imported" means brand-new library rows only. Existing items may still be
	// patched (kind / richer payload / article body) but must not show as "new".
	const itemsImported = newItems.length;
	const itemsSkipped = parsed.items.length - itemsImported;

	const articleUpdatedIds = new Set(articleUpdates.map((item) => item.id));
	const richerUpdatedIds = new Set(richerTweetUpdates.map((item) => item.id));
	const kindOnly = kindUpdates.filter(
		(item) => !articleUpdatedIds.has(item.id) && !richerUpdatedIds.has(item.id),
	);
	const processExternalIds = [
		...newItems.map((item) => item.id),
		...kindOnly.map((item) => item.id),
		...richerTweetUpdates.map((item) => item.id),
	];
	const affectedItemIds =
		processExternalIds.length > 0
			? (
					await db
						.select({ id: items.id })
						.from(items)
						.where(
							and(
								eq(items.source, source),
								inArray(items.externalId, processExternalIds),
							),
						)
				).map((row) => row.id)
			: [];

	await db.insert(imports).values({
		id: createId(),
		filename,
		usersImported,
		itemsImported,
		usersSkipped,
		itemsSkipped,
	});

	const importedExternalIds = new Set(newItems.map((item) => item.id));
	const queueOutcomes = parsed.items.map((item) => ({
		externalId: item.id,
		status: importedExternalIds.has(item.id) ? "imported" as const : "skipped" as const,
	}));
	await resolveImportQueueForExternalIds(source, queueOutcomes);

	return {
		filename,
		parsed: { users: parsed.users.length, items: parsed.items.length },
		users: { imported: usersImported, skipped: usersSkipped },
		items: { imported: itemsImported, skipped: itemsSkipped },
		affectedItemIds,
	};
}
