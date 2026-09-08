import type { CaptureState } from "@repo/import/capture/engine";
import { CAPTURE_KEY } from "../../core/constants";
import { idbDelete, idbGet, idbSet } from "../../core/idb";
import type { MessageRouter } from "../../core/platform";

export function registerCaptureStateHandlers(router: MessageRouter): void {
	router.register("bp-state-load", async () => {
		return { state: await idbGet<CaptureState>(CAPTURE_KEY) };
	});
	router.register("bp-state-save", async (message) => {
		await idbSet(CAPTURE_KEY, message.state);
		return { ok: true };
	});
	router.register("bp-state-clear", async () => {
		await idbDelete(CAPTURE_KEY);
		return { ok: true };
	});
}
