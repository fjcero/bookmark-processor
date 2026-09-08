import { NextRequest, NextResponse } from "next/server";
import { captureCorsHeaders } from "@/lib/capture-cors";
import {
	cancelImportQueueByExternalId,
	enqueueImportQueue,
	listImportQueue,
} from "@/lib/import-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

interface QueuePostBody {
	action?: "enqueue" | "cancel";
	source?: string;
	externalId?: string;
	kind?: string;
	origin?: string;
	payload?: unknown;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	const params = request.nextUrl.searchParams;
	const status = params.get("status") ?? undefined;
	const limit = Number(params.get("limit") ?? "100");
	const offset = Number(params.get("offset") ?? "0");

	const data = await listImportQueue({
		limit: Number.isFinite(limit) ? limit : 100,
		offset: Number.isFinite(offset) ? offset : 0,
		status:
			status === "active" || status === "pending" || status === "importing" ||
			status === "imported" || status === "skipped" || status === "failed" ||
			status === "cancelled"
				? status
				: undefined,
	});

	return NextResponse.json(data, { headers: cors });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	let body: QueuePostBody;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON" },
			{ status: 400, headers: cors },
		);
	}

	const externalId = body.externalId?.trim();
	if (!externalId) {
		return NextResponse.json(
			{ error: "externalId is required" },
			{ status: 400, headers: cors },
		);
	}

	const source = body.source ?? "x";
	const action = body.action ?? "enqueue";

	if (action === "cancel") {
		const cancelled = await cancelImportQueueByExternalId(source, externalId);
		return NextResponse.json({ cancelled }, { headers: cors });
	}

	const result = await enqueueImportQueue({
		source,
		externalId,
		kind: body.kind,
		origin: body.origin ?? "api",
		payload: body.payload,
	});

	return NextResponse.json(result, { headers: cors });
}
