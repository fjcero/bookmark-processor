import { fetchAllLibraryExternalIds } from "@repo/import/capture/engine";
import { idbGet, idbSet } from "./idb";
import { loadSettings } from "./storage";

export const LIBRARY_CACHE_KEY = "bp-library-cache";
export const LIBRARY_CACHE_CAP = 25_000;
export const LIBRARY_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 2_000;

export interface LibraryCacheState {
	ids: string[];
	updatedAt: string;
}

let memoryIds: Set<string> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistQueued = false;

function inBackground(): boolean {
	return typeof window === "undefined";
}

function normalizeIds(ids: Iterable<string>): string[] {
	const next: string[] = [];
	for (const id of ids) {
		if (typeof id === "string" && id.length > 0) next.push(id);
	}
	return next;
}

async function readPersisted(): Promise<LibraryCacheState | null> {
	return idbGet<LibraryCacheState>(LIBRARY_CACHE_KEY);
}

async function writePersisted(ids: Set<string>): Promise<void> {
	await idbSet(LIBRARY_CACHE_KEY, {
		ids: [...ids],
		updatedAt: new Date().toISOString(),
	} satisfies LibraryCacheState);
}

function schedulePersist(): void {
	if (!inBackground()) return;
	persistQueued = true;
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void flushLibraryCacheWrites();
	}, WRITE_DEBOUNCE_MS);
}

export async function flushLibraryCacheWrites(): Promise<void> {
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}
	if (!persistQueued || !memoryIds) return;
	persistQueued = false;
	await writePersisted(memoryIds);
}

async function loadFromBackground(): Promise<Set<string>> {
	try {
		const response = (await chrome.runtime.sendMessage({
			type: "bp-library-cache-load",
		})) as { ok?: boolean; result?: { ids?: string[] } };
		const ids = response?.result?.ids;
		return new Set(Array.isArray(ids) ? normalizeIds(ids) : []);
	} catch {
		return new Set();
	}
}

async function saveToBackground(ids: Iterable<string>): Promise<void> {
	try {
		await chrome.runtime.sendMessage({
			type: "bp-library-cache-save",
			ids: normalizeIds(ids),
		});
	} catch {
		/* background unavailable */
	}
}

export async function loadLibraryCache(): Promise<Set<string>> {
	if (memoryIds) return memoryIds;
	if (inBackground()) {
		const saved = await readPersisted();
		memoryIds = new Set(saved?.ids ?? []);
		return memoryIds;
	}
	memoryIds = await loadFromBackground();
	return memoryIds;
}

export async function saveLibraryCache(
	ids: Iterable<string>,
): Promise<Set<string>> {
	const next = new Set(await loadLibraryCache());
	let added = 0;
	for (const id of normalizeIds(ids)) {
		if (!next.has(id)) {
			next.add(id);
			added += 1;
		}
	}
	memoryIds = next;
	if (added === 0) return next;
	if (inBackground()) {
		schedulePersist();
	} else {
		await saveToBackground(ids);
	}
	return next;
}

export async function replaceLibraryCache(
	ids: Iterable<string>,
): Promise<Set<string>> {
	memoryIds = new Set(normalizeIds(ids));
	if (inBackground()) {
		persistQueued = false;
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		await writePersisted(memoryIds);
	} else {
		await saveToBackground(memoryIds);
	}
	return memoryIds;
}

export function isLibraryCached(id: string): boolean {
	return memoryIds?.has(id) ?? false;
}

export function clearLibraryCacheMemory(): void {
	memoryIds = null;
}

export async function getLibraryCacheMeta(): Promise<{
	count: number;
	updatedAt: string | null;
} | null> {
	const saved = await readPersisted();
	if (!saved) return { count: memoryIds?.size ?? 0, updatedAt: null };
	return {
		count: saved.ids?.length ?? 0,
		updatedAt: saved.updatedAt ?? null,
	};
}

export function libraryCacheNeedsRebuild(
	meta: { count: number; updatedAt: string | null } | null,
	now = Date.now(),
): boolean {
	if (!meta) return false;
	if (meta.count > LIBRARY_CACHE_CAP) return true;
	if (!meta.updatedAt) return true;
	const updated = Date.parse(meta.updatedAt);
	if (!Number.isFinite(updated)) return true;
	return now - updated > LIBRARY_CACHE_STALE_MS;
}

export async function rebuildLibraryCacheFromServer(
	serverUrl: string,
): Promise<number> {
	const fetched = await fetchAllLibraryExternalIds(serverUrl);
	if (fetched.length === 0) return (memoryIds ?? (await loadLibraryCache())).size;
	await replaceLibraryCache(fetched);
	return fetched.length;
}

export async function hydrateLibraryCacheFromServer(
	serverUrl: string,
): Promise<number> {
	return rebuildLibraryCacheFromServer(serverUrl);
}

export async function maybeRebuildLibraryCache(): Promise<boolean> {
	const meta = await getLibraryCacheMeta();
	if (!libraryCacheNeedsRebuild(meta)) return false;
	const settings = await loadSettings();
	if (settings.mode !== "api" || !settings.serverUrl) return false;
	await rebuildLibraryCacheFromServer(settings.serverUrl);
	return true;
}
