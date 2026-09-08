export const ROOT_ID = "bp-capture-root";

export interface SidebarUiRefs {
	root: HTMLElement;
	postsEl: HTMLElement;
	articlesEl: HTMLElement;
	totalEl: HTMLElement;
	syncEl: HTMLElement;
	articleEl: HTMLElement;
	retryBtn: HTMLButtonElement;
	autoBtn: HTMLButtonElement;
}

export function showToast(msg: string): void {
	const t = document.createElement("div");
	t.className = "bp-toast";
	t.textContent = msg;
	document.body.appendChild(t);
	setTimeout(() => {
		t.style.opacity = "0";
		setTimeout(() => t.remove(), 300);
	}, 4000);
}

/** Pick the visible right-hand sidebar (X renders hidden duplicates for responsive layouts). */
function getVisibleSidebar(): HTMLElement | null {
	const candidates = document.querySelectorAll('[data-testid="sidebarColumn"]');
	for (const el of candidates) {
		if (!(el instanceof HTMLElement)) continue;
		if (!isVisible(el)) continue;
		const rect = el.getBoundingClientRect();
		if (rect.width < 200 || rect.height < 100) continue;
		if (rect.left < window.innerWidth * 0.45) continue;
		return el;
	}
	return null;
}

function isVisible(el: HTMLElement): boolean {
	const style = getComputedStyle(el);
	return (
		style.display !== "none" &&
		style.visibility !== "hidden" &&
		el.getBoundingClientRect().width > 0
	);
}

/**
 * Sticky widget stack in the right sidebar (search, trends, who to follow).
 * User target: div.r-vacyoi.r-ttdzmv — 2nd child slot (after search).
 */
function findWidgetStack(sidebar: HTMLElement): HTMLElement | null {
	const selectors = [
		".r-vacyoi.r-ttdzmv",
		'[class*="r-vacyoi"][class*="r-ttdzmv"]',
	];

	for (const selector of selectors) {
		for (const el of sidebar.querySelectorAll<HTMLElement>(selector)) {
			if (!isVisible(el)) continue;
			if (el.querySelector('input[data-testid="SearchBox_Search_Input"]')) {
				return el;
			}
		}
	}

	for (const selector of selectors) {
		const el = sidebar.querySelector<HTMLElement>(selector);
		if (el && isVisible(el)) return el;
	}

	const sticky = sidebar.querySelector(":scope > div");
	return sticky instanceof HTMLElement ? sticky : null;
}

/** Walk up from `el` (inclusive) until `stopAt`, return overflow-hidden ancestor. */
function findClippingAncestor(
	el: HTMLElement,
	stopAt: HTMLElement,
): HTMLElement | null {
	let node: HTMLElement | null = el;
	while (node && node !== stopAt) {
		const { overflow, overflowY } = getComputedStyle(node);
		if (
			overflow === "hidden" ||
			overflowY === "hidden" ||
			overflow === "clip" ||
			overflowY === "clip"
		) {
			return node;
		}
		node = node.parentElement;
	}
	return null;
}

function insertIntoSidebar(root: HTMLElement): boolean {
	const sidebar = getVisibleSidebar();
	if (!sidebar) return false;

	sidebar.querySelector(`#${ROOT_ID}`)?.remove();

	const stack = findWidgetStack(sidebar);
	if (stack) {
		const clipper = findClippingAncestor(stack, sidebar);
		const anchor = clipper ?? stack;
		anchor.insertAdjacentElement("afterend", root);
		if (root.isConnected && sidebar.contains(root)) return true;
	}

	root.classList.remove("bp-sidebar-card--floating");
	sidebar.prepend(root);
	return root.isConnected && sidebar.contains(root);
}

function mountFloating(root: HTMLElement): void {
	document.getElementById(ROOT_ID)?.remove();
	root.classList.add("bp-sidebar-card--floating");
	document.body.appendChild(root);
}

export function buildSidebarPanel(opts: {
	label: string;
	onSyncRetry: () => void;
	onAutoScroll: () => void;
}): SidebarUiRefs {
	const root = document.createElement("div");
	root.id = ROOT_ID;
	root.className = "bp-sidebar-card";

	const title = document.createElement("h2");
	title.className = "bp-sidebar-card__title";
	title.textContent = "Bookmark Processor";

	const syncEl = document.createElement("p");
	syncEl.className = "bp-sidebar-card__sync";
	syncEl.textContent = "Connecting…";

	const header = document.createElement("div");
	header.className = "bp-sidebar-card__header";
	header.append(title, syncEl);

	const body = document.createElement("div");
	body.className = "bp-sidebar-card__body";

	const postsEl = document.createElement("strong");
	postsEl.className = "bp-sidebar-card__metric-value";
	postsEl.textContent = "0";

	const postsLabel = document.createElement("span");
	postsLabel.className = "bp-sidebar-card__metric-label";
	postsLabel.textContent = "Posts";

	const postsMetric = document.createElement("div");
	postsMetric.className = "bp-sidebar-card__metric";
	postsMetric.append(postsLabel, postsEl);

	const articlesEl = document.createElement("strong");
	articlesEl.className = "bp-sidebar-card__metric-value";
	articlesEl.textContent = "0";

	const articlesLabel = document.createElement("span");
	articlesLabel.className = "bp-sidebar-card__metric-label";
	articlesLabel.textContent = "Articles";

	const articleEl = document.createElement("span");
	articleEl.className =
		"bp-sidebar-card__metric-sub bp-sidebar-card__metric-sub--empty";
	articleEl.textContent = "0 in queue";

	const articlesMetric = document.createElement("div");
	articlesMetric.className = "bp-sidebar-card__metric";
	articlesMetric.append(articlesLabel, articlesEl, articleEl);

	const totalEl = document.createElement("strong");
	totalEl.className = "bp-sidebar-card__metric-value";
	totalEl.textContent = "0";

	const totalLabel = document.createElement("span");
	totalLabel.className = "bp-sidebar-card__metric-label";
	totalLabel.textContent = "In library";

	const totalMetric = document.createElement("div");
	totalMetric.className = "bp-sidebar-card__metric";
	totalMetric.append(totalLabel, totalEl);

	const metrics = document.createElement("div");
	metrics.className = "bp-sidebar-card__metrics";
	metrics.append(postsMetric, articlesMetric, totalMetric);

	const actions = document.createElement("div");
	actions.className = "bp-sidebar-card__actions";

	const autoBtn = document.createElement("button");
	autoBtn.type = "button";
	autoBtn.className =
		"bp-sidebar-card__btn bp-sidebar-card__btn--secondary";
	autoBtn.textContent = "Auto-scroll";
	autoBtn.addEventListener("click", opts.onAutoScroll);

	const retryBtn = document.createElement("button");
	retryBtn.type = "button";
	retryBtn.hidden = true;
	retryBtn.className =
		"bp-sidebar-card__btn bp-sidebar-card__btn--secondary bp-sidebar-card__btn--retry";
	retryBtn.textContent = "Retry sync";
	retryBtn.addEventListener("click", opts.onSyncRetry);

	const hint = document.createElement("p");
	hint.className = "bp-sidebar-card__hint";
	hint.textContent = `${opts.label} sync automatically while you scroll.`;

	actions.append(autoBtn, retryBtn);
	body.append(metrics, actions, hint);
	root.append(header, body);

	return {
		root,
		postsEl,
		articlesEl,
		totalEl,
		syncEl,
		articleEl,
		retryBtn,
		autoBtn,
	};
}

export interface LibraryStatsView {
	posts: number | null;
	articles: number | null;
	total: number | null;
}

function formatCount(value: number | null): string {
	return value == null ? "0" : value.toLocaleString();
}

function setMetricValue(el: HTMLElement, value: number | null): void {
	el.textContent = formatCount(value);
}

export function updateLibraryStats(
	refs: SidebarUiRefs,
	stats: LibraryStatsView | null,
): void {
	if (!stats) {
		setMetricValue(refs.postsEl, null);
		setMetricValue(refs.articlesEl, null);
		setMetricValue(refs.totalEl, null);
		return;
	}
	setMetricValue(refs.postsEl, stats.posts);
	setMetricValue(refs.articlesEl, stats.articles);
	setMetricValue(refs.totalEl, stats.total);
}

export function updateSessionStats(
	refs: SidebarUiRefs,
	stats: { new: number; skipped: number; pending: number },
): void {
	const parts = [`${stats.new} new`];
	if (stats.pending > 0) {
		parts.push(`${stats.pending} pending`);
	}
	refs.syncEl.textContent = parts.join(" · ");
	refs.syncEl.classList.remove("bp-sidebar-card__sync--err");
}

export function setSyncStatus(refs: SidebarUiRefs, message: string): void {
	refs.syncEl.textContent = message;
	refs.syncEl.classList.toggle(
		"bp-sidebar-card__sync--err",
		message.toLowerCase().includes("failed"),
	);
}

export function setArticleStatus(
	refs: SidebarUiRefs,
	stats: { pending: number; fetching: number; ok: number; failed: number; total: number },
): void {
	const remaining = stats.pending + stats.fetching;
	refs.articleEl.textContent = `${Math.max(remaining, 0).toLocaleString()} in queue`;
	refs.articleEl.classList.toggle(
		"bp-sidebar-card__metric-sub--empty",
		remaining <= 0,
	);
}

export function setSyncRetryVisible(refs: SidebarUiRefs, visible: boolean): void {
	refs.retryBtn.hidden = !visible;
}

export type AutoScrollUiState = "idle" | "running" | "done";

export function setAutoScrollUi(
	refs: SidebarUiRefs,
	state: AutoScrollUiState,
	count?: number,
): void {
	const btn = refs.autoBtn;
	btn.className = "bp-sidebar-card__btn bp-sidebar-card__btn--secondary";
	if (state === "idle") {
		btn.textContent = "Auto-scroll";
		return;
	}
	if (state === "running") {
		btn.textContent = "Stop scrolling";
		btn.className = "bp-sidebar-card__btn bp-sidebar-card__btn--active";
		return;
	}
	btn.textContent = `Done, ${count ?? 0} captured`;
	btn.className = "bp-sidebar-card__btn bp-sidebar-card__btn--done";
}

export function mountSidebarUi(opts: {
	label: string;
	onSyncRetry: () => void;
	onAutoScroll: () => void;
}): SidebarUiRefs | null {
	const panel = buildSidebarPanel(opts);
	if (insertIntoSidebar(panel.root)) return panel;
	mountFloating(panel.root);
	return panel;
}

export function mountSidebarUiWithRetry(
	opts: {
		label: string;
		onSyncRetry: () => void;
		onAutoScroll: () => void;
	},
	onMounted: (refs: SidebarUiRefs) => void,
): () => void {
	const tryMount = (): boolean => {
		const refs = mountSidebarUi(opts);
		if (!refs) return false;
		onMounted(refs);
		return true;
	};

	if (tryMount()) return () => unmountSidebarUi();

	const observer = new MutationObserver(() => {
		if (tryMount()) observer.disconnect();
	});
	observer.observe(document.body, { childList: true, subtree: true });
	const timeout = setTimeout(() => observer.disconnect(), 60_000);

	return () => {
		observer.disconnect();
		clearTimeout(timeout);
	};
}

export function unmountSidebarUi(): void {
	const el = document.getElementById(ROOT_ID);
	el?.remove();
}
