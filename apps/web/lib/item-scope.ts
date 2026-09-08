import { and, eq, isNull, type SQL } from "drizzle-orm";
import { items } from "@repo/db";
import type { ItemKind } from "@repo/import";

export const BOOKMARK_KIND = "bookmark";

export type LibraryKindFilter = ItemKind | "all";

export const notArchived = isNull(items.archivedAt);
export const isBookmark = eq(items.kind, BOOKMARK_KIND);

/** Listed items: not archived. Optional kind narrows the set when explicitly requested. */
export function listedForKind(kind: LibraryKindFilter = "all"): SQL {
	if (kind === "all") return notArchived;
	return and(notArchived, eq(items.kind, kind))!;
}

export const listedBookmarks = listedForKind("bookmark");
