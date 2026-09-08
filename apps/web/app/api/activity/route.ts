import { NextResponse } from "next/server";
import { getActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
	return NextResponse.json(await getActivity());
}
