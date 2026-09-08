import type { MessageRouter } from "../core/platform";

export function attachMessageListener(router: MessageRouter): void {
	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		void (async () => {
			try {
				const result = await router.dispatch(message, sender);
				sendResponse({ ok: true, result });
			} catch (err) {
				sendResponse({
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		})();
		return true;
	});
}
