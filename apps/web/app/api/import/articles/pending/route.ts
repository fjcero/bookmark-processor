import { NextRequest, NextResponse } from "next/server";
import { captureCorsHeaders } from "@/lib/capture-cors";
import { getPendingArticles } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const url = new URL(request.url);
	const limit = Math.min(Number(url.searchParams.get("limit") ?? 40), 100);
	const articles = await getPendingArticles(Number.isFinite(limit) ? limit : 40);
	return NextResponse.json(
		{ articles },
		{ headers: captureCorsHeaders(request) },
	);
}
