import { idbGet, idbSet } from "./idb";

const LIBRARY_CACHE_KEY = "bp-library-cache";
const PAGE_SIZE = 2000;

interface LibraryCacheState {
	ids: string[];
	updatedAt: string;
}

let memoryIds: Set<string> | null = null;

function normalizeIds(ids: string[]): string[] {
	return ids.filter((id) => typeof id === "string" && id.length > 0);
}

export async function loadLibraryCache(): Promise<Set<string>> {
	if (memoryIds) return memoryIds;
	const saved = await idbGet<LibraryCacheState>(LIBRARY_CACHE_KEY);
	memoryIds = new Set(saved?.ids ?? []);
	return memoryIds;
}

export async function saveLibraryCache(ids: Iterable<string>): Promise<Set<string>> {
	const next = new Set(await loadLibraryCache());
	for (const id of ids) next.add(id);
	memoryIds = next;
	await idbSet(LIBRARY_CACHE_KEY, {
		ids: [...next],
		updatedAt: new Date().toISOString(),
	});
	return next;
}

export function isLibraryCached(id: string): boolean {
	return memoryIds?.has(id) ?? false;
}

export async function hydrateLibraryCacheFromServer(
	serverUrl: string,
): Promise<number> {
	const base = serverUrl.replace(/\/$/, "");
	let cursor = "0";
	const collected: string[] = [];

	for (;;) {
		const res = await fetch(
			`${base}/api/import/known?cursor=${cursor}&limit=${PAGE_SIZE}`,
		);
		if (!res.ok) {
			throw new Error(`Library cache sync failed (${res.status})`);
		}
		const data = (await res.json()) as {
			ids?: string[];
			nextCursor?: string | null;
		};
		const page = normalizeIds(data.ids ?? []);
		collected.push(...page);
		if (!data.nextCursor || page.length === 0) break;
		cursor = data.nextCursor;
	}

	if (collected.length > 0) {
		await saveLibraryCache(collected);
	}
	return collected.length;
}
