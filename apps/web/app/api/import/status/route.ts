import { NextRequest, NextResponse } from "next/server";
import type { ExtensionStatusReport } from "@repo/import";
import { captureCorsHeaders } from "@/lib/capture-cors";
import {
	ackSyncRevocations,
	getSyncStatus,
	saveExtensionStatus,
} from "@/lib/sync-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

interface StatusBody {
	report?: ExtensionStatusReport;
	ackRevocationIds?: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	return NextResponse.json(await getSyncStatus(), { headers: cors });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	let body: StatusBody;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON" },
			{ status: 400, headers: cors },
		);
	}

	if (body.report?.reportedAt) {
		await saveExtensionStatus(body.report);
	}
	if (body.ackRevocationIds?.length) {
		await ackSyncRevocations(body.ackRevocationIds);
	}

	return NextResponse.json(await getSyncStatus(), { headers: cors });
}
