export async function broadcastToTabs(
	urlPatterns: string[],
	message: unknown,
): Promise<void> {
	if (urlPatterns.length === 0) return;
	try {
		const tabs = await chrome.tabs.query({ url: urlPatterns });
		await Promise.all(
			tabs
				.filter((tab) => tab.id != null)
				.map((tab) =>
					chrome.tabs.sendMessage(tab.id!, message).catch(() => {
						/* no content script */
					}),
				),
		);
	} catch {
		/* no listeners */
	}
}
