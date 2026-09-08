import type {
	CaptureState,
	CaptureStorage,
	ExportPayload,
} from "@repo/import/capture/engine";
import type { ImportWorkerProgress } from "@repo/import";
import type { CaptureEventDetail } from "@repo/import/capture/hooks-events";

interface WorkerResponse<T> {
	ok: boolean;
	result?: T;
	error?: string;
}

async function request<T>(message: unknown): Promise<T> {
	try {
		const response = (await chrome.runtime.sendMessage(message)) as WorkerResponse<T>;
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

export function syncInBackground(
	payload: ExportPayload,
	serverUrl: string,
): Promise<{ imported: number; skipped: number; total: number | null }> {
	return request({
		type: "bp-sync",
		payload,
		serverUrl,
	});
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

export async function fetchTotalInBackground(
	serverUrl: string,
): Promise<number | null> {
	const result = await request<{ total: number | null }>({
		type: "bp-fetch-total",
		serverUrl,
	});
	return result.total;
}

export interface TimelineProgress {
	captured: number;
	imported: number;
	skipped: number;
	pages: number;
	running: boolean;
	error?: string;
	libraryTotal?: number | null;
}

export function seedTimelineInBackground(
	detail: CaptureEventDetail,
	source: CaptureState["source"],
	pageUrl: string,
): Promise<{ accepted: boolean }> {
	return request({
		type: "bp-timeline-seed",
		detail,
		source,
		pageUrl,
	});
}
