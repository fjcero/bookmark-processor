import { and, count, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db, items } from "@repo/db";
import type { ActivityDay, ActivitySeries } from "./activity-types";

const listed = isNull(items.archivedAt);
const DAYS = 371;

function startOfRange(): Date {
	const end = new Date();
	end.setHours(0, 0, 0, 0);
	const start = new Date(end);
	start.setDate(start.getDate() - (DAYS - 1));
	return start;
}

function emptySeries(start: Date): Map<string, number> {
	const map = new Map<string, number>();
	const cursor = new Date(start);
	const end = new Date();
	end.setHours(0, 0, 0, 0);
	while (cursor <= end) {
		const y = cursor.getFullYear();
		const m = String(cursor.getMonth() + 1).padStart(2, "0");
		const d = String(cursor.getDate()).padStart(2, "0");
		map.set(`${y}-${m}-${d}`, 0);
		cursor.setDate(cursor.getDate() + 1);
	}
	return map;
}

function toSeries(map: Map<string, number>): ActivityDay[] {
	return [...map.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, count]) => ({ date, count }));
}

function fillCounts(
	map: Map<string, number>,
	rows: Array<{ day: string | null; n: number }>,
): Map<string, number> {
	for (const row of rows) {
		if (row.day) map.set(row.day, row.n);
	}
	return map;
}

async function countsByPublishedAt(start: Date): Promise<Map<string, number>> {
	const map = emptySeries(start);
	const rows = await db
		.select({
			day: sql<string>`date(${items.publishedAt}, 'unixepoch', 'localtime')`.as(
				"day",
			),
			n: count(),
		})
		.from(items)
		.where(
			and(listed, isNotNull(items.publishedAt), gte(items.publishedAt, start)),
		)
		.groupBy(sql`date(${items.publishedAt}, 'unixepoch', 'localtime')`);

	return fillCounts(map, rows);
}

async function countsByBookmarkedAt(start: Date): Promise<Map<string, number>> {
	const map = emptySeries(start);
	const rows = await db
		.select({
			day: sql<string>`date(${items.importedAt}, 'unixepoch', 'localtime')`.as(
				"day",
			),
			n: count(),
		})
		.from(items)
		.where(and(listed, gte(items.importedAt, start)))
		.groupBy(sql`date(${items.importedAt}, 'unixepoch', 'localtime')`);

	return fillCounts(map, rows);
}

export async function getActivity(): Promise<ActivitySeries> {
	const start = startOfRange();
	const [published, bookmarked] = await Promise.all([
		countsByPublishedAt(start),
		countsByBookmarkedAt(start),
	]);
	return {
		published: toSeries(published),
		bookmarked: toSeries(bookmarked),
	};
}
