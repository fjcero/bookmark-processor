import { idbDelete, idbGet, idbSet } from "../../core/idb";
import { loadArticleQueue } from "./article-queue";
import {
	ARTICLE_TABS_KEY,
	ARTICLE_TIMEOUT_PREFIX,
	ARTICLE_WORKER_TAB_KEY,
} from "./constants";

export interface OpenedArticleTab {
	tabId: number;
	articleId: string;
	tweetId: string;
	url: string;
}

export async function loadOpenedTabs(): Promise<OpenedArticleTab[]> {
	return (await idbGet<OpenedArticleTab[]>(ARTICLE_TABS_KEY)) ?? [];
}

export async function saveOpenedTabs(tabs: OpenedArticleTab[]): Promise<void> {
	await idbSet(ARTICLE_TABS_KEY, tabs);
}

export async function findOpenedTab(
	tabId: number,
): Promise<OpenedArticleTab | undefined> {
	return (await loadOpenedTabs()).find((entry) => entry.tabId === tabId);
}

export async function removeOpenedTab(
	tabId: number,
): Promise<OpenedArticleTab | undefined> {
	const tabs = await loadOpenedTabs();
	const opened = tabs.find((entry) => entry.tabId === tabId);
	if (opened) {
		await saveOpenedTabs(tabs.filter((entry) => entry.tabId !== tabId));
	}
	return opened;
}

export async function loadWorkerTabId(): Promise<number | null> {
	return (await idbGet<number>(ARTICLE_WORKER_TAB_KEY)) ?? null;
}

export async function saveWorkerTabId(tabId: number | null): Promise<void> {
	if (tabId == null) {
		await idbDelete(ARTICLE_WORKER_TAB_KEY);
		return;
	}
	await idbSet(ARTICLE_WORKER_TAB_KEY, tabId);
}

/** Open or reuse one background worker tab without stealing focus. */
export async function ensureHydrationTab(url: string): Promise<number | null> {
	const opened = await loadOpenedTabs();
	if (opened.length > 0) {
		const entry = opened[0]!;
		try {
			await chrome.tabs.get(entry.tabId);
			await chrome.tabs.update(entry.tabId, { url, active: false });
			await keepWorkerTabWarm(entry.tabId);
			await saveWorkerTabId(entry.tabId);
			return entry.tabId;
		} catch {
			await saveOpenedTabs([]);
			await saveWorkerTabId(null);
		}
	}

	const savedId = await loadWorkerTabId();
	if (savedId != null) {
		try {
			await chrome.tabs.get(savedId);
			await chrome.tabs.update(savedId, { url, active: false });
			await keepWorkerTabWarm(savedId);
			return savedId;
		} catch {
			await saveWorkerTabId(null);
		}
	}

	const [active] = await chrome.tabs.query({
		active: true,
		currentWindow: true,
	});
	const windowId = active?.windowId;
	const siblings =
		windowId != null
			? await chrome.tabs.query({ windowId })
			: await chrome.tabs.query({ currentWindow: true });
	const tab = await chrome.tabs.create({
		url,
		active: false,
		windowId,
		index: siblings.length,
	});
	if (!tab.id) return null;
	await keepWorkerTabWarm(tab.id);
	await saveWorkerTabId(tab.id);
	return tab.id;
}

async function keepWorkerTabWarm(tabId: number): Promise<void> {
	try {
		await chrome.tabs.update(tabId, { autoDiscardable: false });
	} catch {
		/* tab already gone */
	}
}

export async function discardWorkerTab(): Promise<void> {
	const savedId = await loadWorkerTabId();
	await saveWorkerTabId(null);
	if (savedId == null) return;
	try {
		await chrome.tabs.remove(savedId);
	} catch {
		/* already closed */
	}
}

export async function discardWorkerTabIfIdle(): Promise<void> {
	const queue = await loadArticleQueue();
	const busy = queue.some(
		(item) => item.status === "pending" || item.status === "fetching",
	);
	if (!busy) await discardWorkerTab();
}

export async function closeHydrationTab(tabId: number): Promise<void> {
	await removeOpenedTab(tabId);
	await chrome.alarms.clear(`${ARTICLE_TIMEOUT_PREFIX}${tabId}`);
	await discardWorkerTabIfIdle();
}
