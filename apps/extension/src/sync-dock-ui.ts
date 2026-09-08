export const DOCK_ROOT_ID = "bp-sync-dock";

export interface SyncDockRefs {
	root: HTMLElement;
	panel: HTMLElement;
	fab: HTMLButtonElement;
	statusEl: HTMLElement;
	todaySeenEl: HTMLElement;
	todayNewEl: HTMLElement;
	postsEl: HTMLElement;
	articlesEl: HTMLElement;
	totalEl: HTMLElement;
	queueEl: HTMLElement;
	autoBtn: HTMLButtonElement;
	retryBtn: HTMLButtonElement;
}

const HISTORY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8zm-1-13v6h6v-2h-4V7h-2z"/></svg>`;

function formatCount(value: number | null): string {
	return value == null ? "0" : value.toLocaleString();
}

function setMetricValue(el: HTMLElement, value: number | null): void {
	el.textContent = formatCount(value);
}

export function mountSyncDock(opts: {
	onSyncRetry: () => void;
	onAutoScroll: () => void;
	onPanelOpen?: () => void;
}): SyncDockRefs {
	document.getElementById(DOCK_ROOT_ID)?.remove();

	const root = document.createElement("div");
	root.id = DOCK_ROOT_ID;
	root.className = "bp-sync-dock";

	const panel = document.createElement("div");
	panel.className = "bp-sync-dock__panel";
	panel.hidden = true;

	const header = document.createElement("div");
	header.className = "bp-sync-dock__header";

	const title = document.createElement("h2");
	title.className = "bp-sync-dock__title";
	title.textContent = "History sync";

	header.append(title);

	const body = document.createElement("div");
	body.className = "bp-sync-dock__body";

	const statusEl = document.createElement("p");
	statusEl.className = "bp-sync-dock__status";
	statusEl.hidden = true;

	const todayLabel = document.createElement("p");
	todayLabel.className = "bp-sync-dock__section-label";
	todayLabel.textContent = "This scroll";

	const todaySeenEl = document.createElement("strong");
	todaySeenEl.textContent = "0";
	const todayNewEl = document.createElement("strong");
	todayNewEl.textContent = "0";

	const today = document.createElement("div");
	today.className = "bp-sync-dock__today";
	today.append(
		makeTodayItem(todaySeenEl, "Seen"),
		makeTodayItem(todayNewEl, "New"),
	);

	const libraryLabel = document.createElement("p");
	libraryLabel.className = "bp-sync-dock__section-label";
	libraryLabel.textContent = "Library";

	const postsEl = document.createElement("strong");
	postsEl.className = "bp-sync-dock__metric-value";
	postsEl.textContent = "0";
	const articlesEl = document.createElement("strong");
	articlesEl.className = "bp-sync-dock__metric-value";
	articlesEl.textContent = "0";
	const totalEl = document.createElement("strong");
	totalEl.className = "bp-sync-dock__metric-value";
	totalEl.textContent = "0";

	const queueEl = document.createElement("span");
	queueEl.className =
		"bp-sync-dock__metric-sub bp-sync-dock__metric-sub--empty";
	queueEl.textContent = "0 in queue";

	const metrics = document.createElement("div");
	metrics.className = "bp-sync-dock__metrics";
	metrics.append(
		makeMetric(postsEl, "Posts"),
		makeMetric(articlesEl, "Articles", queueEl),
		makeMetric(totalEl, "Total"),
	);

	const actions = document.createElement("div");
	actions.className = "bp-sync-dock__actions";

	const autoBtn = document.createElement("button");
	autoBtn.type = "button";
	autoBtn.className = "bp-sync-dock__btn bp-sync-dock__btn--secondary";
	autoBtn.textContent = "Auto-scroll";
	autoBtn.addEventListener("click", opts.onAutoScroll);

	const retryBtn = document.createElement("button");
	retryBtn.type = "button";
	retryBtn.hidden = true;
	retryBtn.className = "bp-sync-dock__btn bp-sync-dock__btn--secondary bp-sync-dock__btn--retry";
	retryBtn.textContent = "Retry sync";
	retryBtn.addEventListener("click", opts.onSyncRetry);

	const hint = document.createElement("p");
	hint.className = "bp-sync-dock__hint";
	hint.textContent = "Scroll your history. New items sync automatically.";

	actions.append(autoBtn, retryBtn);
	body.append(statusEl, todayLabel, today, libraryLabel, metrics, actions, hint);
	panel.append(header, body);

	const fab = document.createElement("button");
	fab.type = "button";
	fab.className = "bp-sync-dock__fab";
	fab.setAttribute("aria-label", "History sync");
	fab.setAttribute("aria-expanded", "false");
	fab.innerHTML = HISTORY_ICON;
	fab.addEventListener("click", () => {
		const opened = toggleSyncDockPanel({ root, panel, fab });
		if (opened) opts.onPanelOpen?.();
	});

	root.append(panel, fab);
	document.body.appendChild(root);

	return {
		root,
		panel,
		fab,
		statusEl,
		todaySeenEl,
		todayNewEl,
		postsEl,
		articlesEl,
		totalEl,
		queueEl,
		autoBtn,
		retryBtn,
	};
}

function makeTodayItem(valueEl: HTMLElement, label: string): HTMLElement {
	const item = document.createElement("div");
	item.className = "bp-sync-dock__today-item";
	const labelEl = document.createElement("span");
	labelEl.textContent = label;
	item.append(labelEl, valueEl);
	return item;
}

function makeMetric(
	valueEl: HTMLElement,
	label: string,
	subEl?: HTMLElement,
): HTMLElement {
	const metric = document.createElement("div");
	metric.className = "bp-sync-dock__metric";
	const labelEl = document.createElement("span");
	labelEl.className = "bp-sync-dock__metric-label";
	labelEl.textContent = label;
	metric.append(labelEl, valueEl);
	if (subEl) metric.append(subEl);
	return metric;
}

export function toggleSyncDockPanel(
	refs: Pick<SyncDockRefs, "root" | "panel" | "fab">,
	open?: boolean,
): boolean {
	const isOpen =
		open ?? !refs.panel.classList.contains("bp-sync-dock__panel--open");
	refs.panel.hidden = !isOpen;
	refs.panel.classList.toggle("bp-sync-dock__panel--open", isOpen);
	refs.fab.classList.toggle("bp-sync-dock__fab--open", isOpen);
	refs.fab.setAttribute("aria-expanded", String(isOpen));
	return isOpen;
}

export function unmountSyncDock(): void {
	document.getElementById(DOCK_ROOT_ID)?.remove();
}

export function updateDockSessionStats(
	refs: SyncDockRefs,
	stats: {
		seen: number;
		new: number;
		pending: number;
	},
): void {
	refs.todaySeenEl.textContent = stats.seen.toLocaleString();
	refs.todayNewEl.textContent = stats.new.toLocaleString();
}

export function updateDockLibraryStats(
	refs: SyncDockRefs,
	stats: {
		posts: number | null;
		articles: number | null;
		total: number | null;
	} | null,
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

export function setDockArticleQueue(
	refs: SyncDockRefs,
	remaining: number,
): void {
	refs.queueEl.textContent = `${Math.max(remaining, 0).toLocaleString()} in queue`;
	refs.queueEl.classList.toggle(
		"bp-sync-dock__metric-sub--empty",
		remaining <= 0,
	);
}

export function setDockSyncStatus(refs: SyncDockRefs, message: string): void {
	if (!message) {
		refs.statusEl.hidden = true;
		refs.statusEl.textContent = "";
		return;
	}
	refs.statusEl.hidden = false;
	refs.statusEl.textContent = message;
}

export function setDockSyncRetryVisible(
	refs: SyncDockRefs,
	visible: boolean,
): void {
	refs.retryBtn.hidden = !visible;
}

export type DockAutoScrollState = "idle" | "running" | "done";

export function setDockAutoScrollUi(
	refs: SyncDockRefs,
	state: DockAutoScrollState,
	count?: number,
): void {
	const btn = refs.autoBtn;
	btn.className = "bp-sync-dock__btn bp-sync-dock__btn--secondary";
	if (state === "idle") {
		btn.textContent = "Auto-scroll";
		return;
	}
	if (state === "running") {
		btn.textContent = "Stop scrolling";
		btn.className = "bp-sync-dock__btn bp-sync-dock__btn--active";
		return;
	}
	btn.textContent = `Done, ${count ?? 0} scrolled`;
	btn.className = "bp-sync-dock__btn bp-sync-dock__btn--done";
}
