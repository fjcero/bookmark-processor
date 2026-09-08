import {
	toPersistedCaptureState,
	type CaptureState,
} from "@repo/import/capture/engine";
import { CAPTURE_KEY } from "../../core/constants";
import { idbDelete, idbGet, idbSet } from "../../core/idb";
import type { MessageRouter } from "../../core/platform";

async function loadCaptureState(): Promise<CaptureState | null> {
	const capture = await idbGet<CaptureState>(CAPTURE_KEY);
	if (!capture) return null;
	const slim = toPersistedCaptureState(capture);
	const tweetCount = Object.keys(slim.tweets ?? {}).length;
	if (tweetCount === 0 && !(slim.responses?.length)) {
		await idbDelete(CAPTURE_KEY);
		return null;
	}
	if (
		(capture.synced?.length ?? 0) > 0 ||
		(capture.seen?.length ?? 0) !== (slim.seen?.length ?? 0)
	) {
		await idbSet(CAPTURE_KEY, slim);
	}
	return slim;
}

export function registerCaptureStateHandlers(router: MessageRouter): void {
	router.register("bp-state-load", async () => {
		return { state: await loadCaptureState() };
	});
	router.register("bp-state-save", async (message) => {
		const state = message.state as CaptureState;
		const slim = toPersistedCaptureState(state);
		const tweetCount = Object.keys(slim.tweets ?? {}).length;
		if (tweetCount === 0 && !(slim.responses?.length)) {
			await idbDelete(CAPTURE_KEY);
			return { ok: true };
		}
		await idbSet(CAPTURE_KEY, slim);
		return { ok: true };
	});
	router.register("bp-state-clear", async () => {
		await idbDelete(CAPTURE_KEY);
		return { ok: true };
	});
}
