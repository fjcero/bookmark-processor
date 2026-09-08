import { NextRequest, NextResponse } from "next/server";
import { captureCorsHeaders } from "@/lib/capture-cors";
import { noteCaptureUnavailable } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	let body: { source?: string; externalId?: string };
	try {
		body = (await request.json()) as { source?: string; externalId?: string };
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON" },
			{ status: 400, headers: captureCorsHeaders(request) },
		);
	}

	const source = typeof body.source === "string" ? body.source.trim() : "x";
	const externalId =
		typeof body.externalId === "string" ? body.externalId.trim() : "";
	if (!externalId) {
		return NextResponse.json(
			{ error: "Missing externalId" },
			{ status: 400, headers: captureCorsHeaders(request) },
		);
	}

	const { kept } = await noteCaptureUnavailable(source, externalId);
	return NextResponse.json(
		{ ok: true, archived: false, kept },
		{ headers: captureCorsHeaders(request) },
	);
}
