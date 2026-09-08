import { NextRequest, NextResponse } from "next/server";
import { captureCorsHeaders } from "@/lib/capture-cors";
import {
	filterKnownExternalIds,
	listLibraryExternalIds,
} from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IDS = 500;
const MAX_PAGE = 5000;

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	const url = new URL(request.url);
	const source = (url.searchParams.get("source") ?? "x").trim();
	const cursor = Math.max(0, Number(url.searchParams.get("cursor") ?? "0"));
	const limit = Math.min(
		Math.max(1, Number(url.searchParams.get("limit") ?? "2000")),
		MAX_PAGE,
	);
	const offset = Number.isFinite(cursor) ? cursor : 0;
	const ids = await listLibraryExternalIds(source, offset, limit);
	const nextCursor =
		ids.length === limit ? String(offset + ids.length) : null;
	return NextResponse.json({ ids, nextCursor }, { headers: cors });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	let body: { source?: string; externalIds?: string[] };
	try {
		body = (await request.json()) as {
			source?: string;
			externalIds?: string[];
		};
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON" },
			{ status: 400, headers: cors },
		);
	}

	const source = typeof body.source === "string" ? body.source.trim() : "x";
	const externalIds = Array.isArray(body.externalIds)
		? body.externalIds
				.filter((id): id is string => typeof id === "string" && id.length > 0)
				.slice(0, MAX_IDS)
		: [];

	if (externalIds.length === 0) {
		return NextResponse.json({ known: [] }, { headers: cors });
	}

	const known = await filterKnownExternalIds(source, externalIds);
	return NextResponse.json({ known }, { headers: cors });
}
