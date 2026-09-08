import { and, eq, inArray } from "drizzle-orm";
import { db, itemRaw } from "@repo/db";
import { chooseBetterRawJson } from "@repo/import";

export async function getItemRaw(
	source: string,
	externalId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ payload: itemRaw.payload })
		.from(itemRaw)
		.where(
			and(eq(itemRaw.source, source), eq(itemRaw.externalId, externalId)),
		)
		.limit(1);
	return row?.payload ?? null;
}

export async function getItemRaws(
	source: string,
	externalIds: string[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (externalIds.length === 0) return map;
	const CHUNK = 400;
	for (let i = 0; i < externalIds.length; i += CHUNK) {
		const slice = externalIds.slice(i, i + CHUNK);
		const rows = await db
			.select({
				externalId: itemRaw.externalId,
				payload: itemRaw.payload,
			})
			.from(itemRaw)
			.where(
				and(eq(itemRaw.source, source), inArray(itemRaw.externalId, slice)),
			);
		for (const row of rows) map.set(row.externalId, row.payload);
	}
	return map;
}

/** Insert, or replace only when incoming is a better extract. Returns true if stored. */
export async function upsertItemRaw(
	source: string,
	externalId: string,
	incomingJson: string,
	now = new Date(),
): Promise<boolean> {
	if (!incomingJson) return false;
	const existing = await getItemRaw(source, externalId);
	const next = chooseBetterRawJson(incomingJson, existing);
	if (next == null) return false;
	await db
		.insert(itemRaw)
		.values({
			source,
			externalId,
			payload: next,
			payloadBytes: next.length,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [itemRaw.source, itemRaw.externalId],
			set: {
				payload: next,
				payloadBytes: next.length,
				updatedAt: now,
			},
		});
	return true;
}

export async function upsertItemRaws(
	source: string,
	entries: Array<{ externalId: string; payload: string }>,
	now = new Date(),
): Promise<void> {
	for (const entry of entries) {
		await upsertItemRaw(source, entry.externalId, entry.payload, now);
	}
}
