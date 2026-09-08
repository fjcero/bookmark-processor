import { NextRequest, NextResponse } from "next/server";
import { captureCorsHeaders } from "@/lib/capture-cors";
import { importExportJson } from "@/lib/import-core";
import {
	getImportPrefs,
	selectedStages,
	setImportPrefs,
	type ImportPrefs,
} from "@/lib/settings";
import { getProcessState, startProcess } from "@/lib/processor";
import { getStats } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest): Promise<NextResponse> {
	return new NextResponse(null, {
		status: 204,
		headers: captureCorsHeaders(request),
	});
}

export async function GET(request: NextRequest): Promise<NextResponse> {
	const stats = await getStats();
	return NextResponse.json(
		{
			total: stats.items,
			posts: stats.posts.total,
			articles: stats.articles.total,
		},
		{ headers: captureCorsHeaders(request) },
	);
}

interface CaptureBody {
	exportVersion?: number;
	source?: string;
	tweets?: Record<string, unknown>;
	responses?: unknown[];
	entities?: boolean;
	understanding?: boolean;
	categorize?: boolean;
}

function filenameFromSource(source: string | undefined): string {
	if (source === "like") return "likes.json";
	if (source === "own") return "own.json";
	return "bookmarks.json";
}

function parseBodyFlag(
	value: unknown,
	fallback: boolean,
): boolean {
	if (value == null) return fallback;
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "1" || value === "on") return true;
	if (value === "false" || value === "0" || value === "off") return false;
	return fallback;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const cors = captureCorsHeaders(request);
	let body: CaptureBody;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON" },
			{ status: 400, headers: cors },
		);
	}

	if (body.exportVersion !== 2 || !body.tweets) {
		return NextResponse.json(
			{ error: "Expected exportVersion 2 with tweets map" },
			{ status: 400, headers: cors },
		);
	}

	const tweetCount = Object.keys(body.tweets).length;
	if (tweetCount === 0) {
		return NextResponse.json(
			{ error: "No tweets in export" },
			{ status: 400, headers: cors },
		);
	}

	const saved = await getImportPrefs();
	const prefs: ImportPrefs = {
		entities: parseBodyFlag(body.entities, saved.entities),
		understanding: parseBodyFlag(body.understanding, saved.understanding),
		categorize: parseBodyFlag(body.categorize, saved.categorize),
	};
	await setImportPrefs(prefs);

	const result = await importExportJson(
		JSON.stringify(body),
		filenameFromSource(body.source),
	);

	if (result.error) {
		return NextResponse.json(
			{ error: result.error },
			{ status: 400, headers: cors },
		);
	}

	// Tweet shells in the payload (no author / article) must still count as handled
	// so the extension worker can dequeue the full batch.
	const unparseable = tweetCount - result.parsed.items;
	if (unparseable > 0) {
		result.items.skipped += unparseable;
	}

	const stages = selectedStages(prefs);
	let processing = false;
	if (stages.length > 0 && result.affectedItemIds.length > 0) {
		if (getProcessState().status !== "running") {
			processing = true;
			void startProcess({ stages, itemIds: result.affectedItemIds });
		}
	}
	const stats = await getStats();

	return NextResponse.json(
		{
			...result,
			total: stats.items,
			posts: stats.posts.total,
			articles: stats.articles.total,
			prefs,
			processing,
		},
		{ headers: cors },
	);
}
