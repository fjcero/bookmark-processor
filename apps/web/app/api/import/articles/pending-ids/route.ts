import { NextRequest, NextResponse } from "next/server";
import { captureCorsHeaders } from "@/lib/capture-cors";
import { listPendingArticleTweetIds } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const tweetIds = await listPendingArticleTweetIds();
	return NextResponse.json(
		{ tweetIds },
		{ headers: captureCorsHeaders(request) },
	);
}
