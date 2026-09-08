import type {
	CaptureState,
	CaptureStorage,
	ExportPayload,
} from "@repo/import/capture/engine";
import type { ImportWorkerProgress } from "@repo/import";

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

