import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db, importQueue, items } from "@repo/db";
import type {
	ImportQueueCounts,
	ImportQueueItemDto,
	ImportQueueStatus,
} from "@repo/import";
import { createId } from "@/lib/ids";

const ACTIVE_STATUSES: ImportQueueStatus[] = ["pending", "importing"];

function rowToDto(
	row: typeof importQueue.$inferSelect,
	preview: string | null = null,
): ImportQueueItemDto {
	return {
		id: row.id,
		source: row.source,
		kind: row.kind,
		externalId: row.externalId,
		status: row.status as ImportQueueStatus,
		origin: row.origin,
		lastError: row.lastError,
		itemId: row.itemId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		preview,
	};
}

export async function getImportQueueCounts(): Promise<ImportQueueCounts> {
	const rows = await db
		.select({
			status: importQueue.status,
			n: count(),
		})
		.from(importQueue)
		.groupBy(importQueue.status);

	const counts: ImportQueueCounts = {
		pending: 0,
		importing: 0,
		imported: 0,
		skipped: 0,
		failed: 0,
		cancelled: 0,
		total: 0,
	};
	for (const row of rows) {
		const key = row.status as ImportQueueStatus;
		if (key in counts) {
			(counts as Record<ImportQueueStatus, number>)[key] = row.n;
		}
		counts.total += row.n;
	}
	return counts;
}

async function previewForExternalIds(
	source: string,
	externalIds: string[],
): Promise<Map<string, string | null>> {
	if (externalIds.length === 0) return new Map();
	const rows = await db
		.select({ externalId: items.externalId, text: items.text })
		.from(items)
		.where(
			and(eq(items.source, source), inArray(items.externalId, externalIds)),
		);
	return new Map(
		rows.map((row) => [
			row.externalId,
			row.text.length > 160 ? `${row.text.slice(0, 157)}…` : row.text,
		]),
	);
}

export async function listImportQueue(options?: {
	limit?: number;
	offset?: number;
	status?: ImportQueueStatus | "active";
}): Promise<{
	items: ImportQueueItemDto[];
	total: number;
	counts: ImportQueueCounts;
}> {
	const limit = options?.limit ?? 100;
	const offset = options?.offset ?? 0;
	const status = options?.status;

	const where =
		status === "active"
			? inArray(importQueue.status, ACTIVE_STATUSES)
			: status
				? eq(importQueue.status, status)
				: undefined;

	const [totalRow] = await db
		.select({ n: count() })
		.from(importQueue)
		.where(where);

	const rows = await db
		.select()
		.from(importQueue)
		.where(where)
		.orderBy(desc(importQueue.createdAt))
		.limit(limit)
		.offset(offset);

	const previews = new Map<string, string | null>();
	const bySource = new Map<string, string[]>();
	for (const row of rows) {
		const list = bySource.get(row.source) ?? [];
		list.push(row.externalId);
		bySource.set(row.source, list);
	}
	for (const [rowSource, ids] of bySource) {
		const map = await previewForExternalIds(rowSource, ids);
		for (const [externalId, text] of map) {
			previews.set(`${rowSource}:${externalId}`, text);
		}
	}

	return {
		items: rows.map((row) =>
			rowToDto(row, previews.get(`${row.source}:${row.externalId}`) ?? null),
		),
		total: totalRow?.n ?? 0,
		counts: await getImportQueueCounts(),
	};
}

export async function enqueueImportQueue(input: {
	source?: string;
	externalId: string;
	kind?: string;
	origin: string;
	payload?: unknown;
}): Promise<{ item: ImportQueueItemDto; created: boolean }> {
	const now = new Date();
	const source = input.source ?? "x";
	const kind = input.kind ?? "bookmark";
	const payloadJson =
		input.payload != null ? JSON.stringify(input.payload) : null;

	const [existing] = await db
		.select()
		.from(importQueue)
		.where(
			and(
				eq(importQueue.source, source),
				eq(importQueue.externalId, input.externalId),
			),
		)
		.limit(1);

	if (existing) {
		if (
			existing.status === "imported" ||
			existing.status === "skipped" ||
			existing.status === "pending" ||
			existing.status === "importing"
		) {
			return { item: rowToDto(existing), created: false };
		}

		await db
			.update(importQueue)
			.set({
				status: "pending",
				kind,
				origin: input.origin,
				payloadJson,
				lastError: null,
				itemId: null,
				updatedAt: now,
			})
			.where(eq(importQueue.id, existing.id));

		const [updated] = await db
			.select()
			.from(importQueue)
			.where(eq(importQueue.id, existing.id))
			.limit(1);
		return { item: rowToDto(updated ?? existing), created: false };
	}

	const id = createId();
	await db.insert(importQueue).values({
		id,
		source,
		kind,
		externalId: input.externalId,
		status: "pending",
		origin: input.origin,
		payloadJson,
		createdAt: now,
		updatedAt: now,
	});

	const [row] = await db
		.select()
		.from(importQueue)
		.where(eq(importQueue.id, id))
		.limit(1);

	return { item: rowToDto(row!), created: true };
}

export async function cancelImportQueueByExternalId(
	source: string,
	externalId: string,
): Promise<boolean> {
	const now = new Date();
	const rows = await db
		.select({ id: importQueue.id })
		.from(importQueue)
		.where(
			and(
				eq(importQueue.source, source),
				eq(importQueue.externalId, externalId),
				inArray(importQueue.status, ACTIVE_STATUSES),
			),
		);
	if (rows.length === 0) return false;
	await db
		.update(importQueue)
		.set({ status: "cancelled", updatedAt: now })
		.where(inArray(importQueue.id, rows.map((row) => row.id)));
	return true;
}

export async function cancelImportQueueItem(id: string): Promise<boolean> {
	const now = new Date();
	const [row] = await db
		.select({ id: importQueue.id })
		.from(importQueue)
		.where(
			and(eq(importQueue.id, id), inArray(importQueue.status, ACTIVE_STATUSES)),
		)
		.limit(1);
	if (!row) return false;
	await db
		.update(importQueue)
		.set({ status: "cancelled", updatedAt: now })
		.where(eq(importQueue.id, id));
	return true;
}

export async function resolveImportQueueForExternalIds(
	source: string,
	outcomes: Array<{
		externalId: string;
		status: "imported" | "skipped";
		itemId?: string;
	}>,
): Promise<void> {
	if (outcomes.length === 0) return;
	const now = new Date();
	const externalIds = outcomes.map((entry) => entry.externalId);
	const [rows] = await Promise.all([
		db
			.select()
			.from(importQueue)
			.where(
				and(
					eq(importQueue.source, source),
					inArray(importQueue.externalId, externalIds),
					inArray(importQueue.status, [...ACTIVE_STATUSES, "failed"]),
				),
			),
	]);

	const byExternalId = new Map(rows.map((row) => [row.externalId, row]));
	for (const outcome of outcomes) {
		const row = byExternalId.get(outcome.externalId);
		if (!row) continue;
		await db
			.update(importQueue)
			.set({
				status: outcome.status,
				itemId: outcome.itemId ?? row.itemId,
				lastError: null,
				updatedAt: now,
			})
			.where(eq(importQueue.id, row.id));
	}
}

export async function markImportQueueImporting(
	source: string,
	externalIds: string[],
): Promise<void> {
	if (externalIds.length === 0) return;
	const now = new Date();
	await db
		.update(importQueue)
		.set({ status: "importing", updatedAt: now })
		.where(
			and(
				eq(importQueue.source, source),
				inArray(importQueue.externalId, externalIds),
				eq(importQueue.status, "pending"),
			),
		);
}
