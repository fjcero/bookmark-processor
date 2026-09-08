import { NextRequest, NextResponse } from "next/server";
import { cancelImportQueueItem } from "@/lib/import-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
	const { id } = await params;
	const cancelled = await cancelImportQueueItem(id);
	if (!cancelled) {
		return NextResponse.json(
			{ error: "Queue item not found or not cancellable" },
			{ status: 404 },
		);
	}
	return NextResponse.json({ cancelled: true });
}
