import type {
	CaptureState,
	CaptureStorage,
	ExportPayload,
	LibraryStats,
} from "@repo/import/capture/engine";
import type { ImportWorkerProgress } from "@repo/import";

interface WorkerResponse<T> {
	ok: boolean;
	result?: T;
	error?: string;
}

async function request<T>(message: unknown): Promise<T> {
	try {
		const response = (await chrome.runtime.sendMessage(
			message,
		)) as WorkerResponse<T>;
		if (!response?.ok) {
			throw new Error(response?.error ?? "Background worker unavailable");
		}
		return response.result as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(message);
	}
}

export function createBackgroundStorageAdapter(): CaptureStorage {
	return {
		async load() {
			const result = await request<{ state: CaptureState | null }>({
				type: "bp-state-load",
			});
			return result.state;
		},
		async save(state) {
			await request({ type: "bp-state-save", state });
		},
		async clear() {
			await request({ type: "bp-state-clear" });
		},
	};
}

export function enqueueImportsInBackground(
	payload: ExportPayload,
	serverUrl: string,
): Promise<ImportWorkerProgress> {
	return request({
		type: "bp-import-enqueue",
		payload,
		serverUrl,
	});
}

export async function fetchLibraryStatsInBackground(
	serverUrl: string,
): Promise<LibraryStats | null> {
	try {
		return await request<LibraryStats>({
			type: "bp-fetch-total",
			serverUrl,
		});
	} catch {
		return null;
	}
}

export async function filterKnownExternalIdsInBackground(
	serverUrl: string,
	externalIds: string[],
	source = "x",
): Promise<string[]> {
	if (externalIds.length === 0) return [];
	try {
		const result = await request<{ known: string[] }>({
			type: "bp-filter-known",
			serverUrl,
			externalIds,
			source,
		});
		return Array.isArray(result.known) ? result.known : [];
	} catch {
		return [];
	}
}

export async function hydrateLibraryCacheInBackground(
	serverUrl: string,
): Promise<{ count: number }> {
	return await request<{ count: number }>({
		type: "bp-hydrate-library-cache",
		serverUrl,
	});
}

export async function fetchTodayStatsInBackground(
	serverUrl: string,
): Promise<import("@repo/import/capture/engine").TodayImportStats | null> {
	try {
		return await request<import("@repo/import/capture/engine").TodayImportStats>(
			{
				type: "bp-fetch-today",
				serverUrl,
			},
		);
	} catch {
		return null;
	}
}

export async function reconcileArticlesInBackground(
	serverUrl: string,
): Promise<{ removed: number }> {
	return await request<{ removed: number }>({
		type: "bp-reconcile-articles",
		serverUrl,
	});
}

/** @deprecated Use fetchLibraryStatsInBackground */
export async function fetchTotalInBackground(
	serverUrl: string,
): Promise<number | null> {
	const stats = await fetchLibraryStatsInBackground(serverUrl);
	return stats?.total ?? null;
}
