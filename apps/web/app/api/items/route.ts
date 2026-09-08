import { NextRequest, NextResponse } from "next/server";
import { listItems } from "@/lib/queries";
import type { ContentType, PostFormat } from "@repo/import";
import { DEFAULT_ITEM_SORT, type ItemSort } from "@/lib/import-prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES = new Set<ContentType>(["post", "article"]);
const POST_FORMATS = new Set<PostFormat>([
	"original",
	"reply",
	"quote",
	"repost",
	"thread",
]);

export async function GET(request: NextRequest): Promise<NextResponse> {
	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
	const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
	const uncategorized = url.searchParams.get("uncategorized") === "true";
	const q = url.searchParams.get("q")?.trim() || undefined;
	const sortRaw = url.searchParams.get("sort");
	const contentTypeRaw = url.searchParams.get("contentType");
	const postFormatRaw = url.searchParams.get("postFormat");

	const SORTS = new Set<ItemSort>(["published", "imported", "saved"]);
	const sort =
		sortRaw && SORTS.has(sortRaw as ItemSort)
			? (sortRaw as ItemSort)
			: DEFAULT_ITEM_SORT;

	const contentType =
		contentTypeRaw && CONTENT_TYPES.has(contentTypeRaw as ContentType)
			? (contentTypeRaw as ContentType)
			: undefined;
	const postFormat =
		postFormatRaw && POST_FORMATS.has(postFormatRaw as PostFormat)
			? (postFormatRaw as PostFormat)
			: undefined;

	const result = await listItems({
		limit,
		offset,
		uncategorized,
		search: { q, contentType, postFormat },
		sort,
	});

	return NextResponse.json(result);
}
