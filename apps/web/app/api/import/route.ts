import { NextRequest, NextResponse } from "next/server";
import { importExportJson } from "@/lib/import-core";
import {
	getImportPrefs,
	selectedStages,
	setImportPrefs,
	type ImportPrefs,
} from "@/lib/settings";
import { getProcessState, startProcess } from "@/lib/processor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FileImportResult = Awaited<ReturnType<typeof importExportJson>>;

async function importOneFile(file: File, now: Date): Promise<FileImportResult> {
	const text = await file.text();
	return importExportJson(text, file.name, now);
}

function getUploadFiles(form: FormData): File[] {
	const fromMulti = form
		.getAll("file")
		.filter((entry): entry is File => entry instanceof File);
	if (fromMulti.length > 0) return fromMulti;
	const single = form.get("file");
	return single instanceof File ? [single] : [];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
	const form = await request.formData();
	const files = getUploadFiles(form);
	if (files.length === 0) {
		return NextResponse.json({ error: "Missing file" }, { status: 400 });
	}

	const saved = await getImportPrefs();
	const prefs: ImportPrefs = {
		entities: parseFormFlag(form.get("entities"), saved.entities),
		understanding: parseFormFlag(
			form.get("understanding"),
			saved.understanding,
		),
		categorize: parseFormFlag(form.get("categorize"), saved.categorize),
	};
	await setImportPrefs(prefs);

	const now = new Date();
	const results: FileImportResult[] = [];
	for (const file of files) {
		results.push(await importOneFile(file, now));
	}

	const failures = results.filter((r) => r.error);
	if (failures.length === results.length) {
		return NextResponse.json(
			{
				error: failures.map((r) => `${r.filename}: ${r.error}`).join("; "),
				files: results,
			},
			{ status: 400 },
		);
	}

	const totals = {
		users: {
			imported: results.reduce((n, r) => n + r.users.imported, 0),
			skipped: results.reduce((n, r) => n + r.users.skipped, 0),
		},
		items: {
			imported: results.reduce((n, r) => n + r.items.imported, 0),
			skipped: results.reduce((n, r) => n + r.items.skipped, 0),
		},
	};

	const stages = selectedStages(prefs);
	let processing = false;
	if (stages.length > 0 && totals.items.imported > 0) {
		if (getProcessState().status !== "running") {
			processing = true;
			void startProcess({ stages });
		}
	}

	const first = results[0];
	return NextResponse.json({
		filename: files.length === 1 ? first.filename : `${files.length} files`,
		files: results,
		totals,
		parsed: {
			users: results.reduce((n, r) => n + r.parsed.users, 0),
			items: results.reduce((n, r) => n + r.parsed.items, 0),
		},
		users: totals.users,
		items: totals.items,
		prefs,
		processing,
		errors:
			failures.length > 0
				? failures.map((r) => `${r.filename}: ${r.error}`)
				: undefined,
	});
}

function parseFormFlag(
	value: FormDataEntryValue | null,
	fallback: boolean,
): boolean {
	if (value == null || value === "") return fallback;
	return value === "true" || value === "1" || value === "on";
}
