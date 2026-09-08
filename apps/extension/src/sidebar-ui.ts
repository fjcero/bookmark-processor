export const ROOT_ID = "bp-capture-root";

export interface SidebarUiRefs {
	root: HTMLElement;
	statEl: HTMLElement;
	totalEl: HTMLElement;
	syncEl: HTMLElement;
	articleEl: HTMLElement;
	workerSummaryEl: HTMLElement;
	workerLogEl: HTMLOListElement;
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

	const stack = findWidgetStack(sidebar);
	if (!stack) return false;

	sidebar.querySelector(`#${ROOT_ID}`)?.remove();

	// Escape sticky/overflow-hidden wrappers — insert after the clipping box, not inside it.
	const clipper = findClippingAncestor(stack, sidebar);
	const anchor = clipper ?? stack;
	anchor.insertAdjacentElement("afterend", root);

	return root.isConnected && sidebar.contains(root);
}

export function buildSidebarPanel(opts: {
	label: string;
	count: number;
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

	const statEl = document.createElement("strong");
	statEl.className = "bp-sidebar-card__stat";
	statEl.textContent = String(opts.count);

	const pendingLabel = document.createElement("span");
	pendingLabel.textContent = "Pending sync";

	const pendingMetric = document.createElement("div");
	pendingMetric.className = "bp-sidebar-card__metric";
	pendingMetric.append(statEl, pendingLabel);

	const totalEl = document.createElement("strong");
	totalEl.className = "bp-sidebar-card__total";
	totalEl.textContent = "—";

	const totalLabel = document.createElement("span");
	totalLabel.textContent = "In library";

	const totalMetric = document.createElement("div");
	totalMetric.className = "bp-sidebar-card__metric";
	totalMetric.append(totalEl, totalLabel);

	const metrics = document.createElement("div");
	metrics.className = "bp-sidebar-card__metrics";
	metrics.append(pendingMetric, totalMetric);

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

	const articleEl = document.createElement("p");
	articleEl.className = "bp-sidebar-card__hint";
	articleEl.textContent = "Articles idle";

	const workerSummaryEl = document.createElement("span");
	workerSummaryEl.className = "bp-worker__summary-text";
	workerSummaryEl.textContent = "Worker idle";

	const workerDot = document.createElement("span");
	workerDot.className = "bp-worker__dot";
	workerDot.setAttribute("aria-hidden", "true");

	const workerSummary = document.createElement("summary");
	workerSummary.append(workerDot, workerSummaryEl);

	const workerLogEl = document.createElement("ol");
	workerLogEl.className = "bp-worker__log";

	const worker = document.createElement("details");
	worker.className = "bp-worker";
	worker.append(workerSummary, workerLogEl);

	const hint = document.createElement("p");
	hint.className = "bp-sidebar-card__hint";
	hint.textContent = `${opts.label} sync automatically while you scroll.`;

	actions.append(autoBtn, retryBtn);
	body.append(metrics, actions, articleEl, worker, hint);
	root.append(header, body);

	return {
		root,
		statEl,
		totalEl,
		syncEl,
		articleEl,
		workerSummaryEl,
		workerLogEl,
		retryBtn,
		autoBtn,
	};
}

export function updateSidebarCount(
	refs: SidebarUiRefs,
	count: number | string,
	label = "Pending sync",
): void {
	refs.statEl.textContent = String(count);
	const labelEl = refs.statEl.nextElementSibling;
	if (labelEl instanceof HTMLElement) labelEl.textContent = label;
}

export function updateServerTotal(
	refs: SidebarUiRefs,
	total: number | null,
): void {
	refs.totalEl.textContent = total == null ? "—" : total.toLocaleString();
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
	libraryMissing: number | null = null,
): void {
	const remaining = stats.pending + stats.fetching;
	refs.articleEl.textContent =
		libraryMissing != null
			? `${remaining.toLocaleString()} active · ${libraryMissing.toLocaleString()} missing in library`
			: `${remaining.toLocaleString()} articles active`;
}

export function trackWorkerActivity(
	refs: SidebarUiRefs,
	message: string,
	tone: "active" | "success" | "error" | "idle" = "active",
): void {
	refs.workerSummaryEl.textContent = message;
	const worker = refs.workerSummaryEl.closest(".bp-worker");
	if (worker) worker.setAttribute("data-tone", tone);

	const item = document.createElement("li");
	const time = document.createElement("time");
	time.dateTime = new Date().toISOString();
	time.textContent = new Date().toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const text = document.createElement("span");
	text.textContent = message;
	item.append(time, text);
	refs.workerLogEl.prepend(item);
	while (refs.workerLogEl.children.length > 8) {
		refs.workerLogEl.lastElementChild?.remove();
	}
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
	btn.textContent = `Done — ${count ?? 0} captured`;
	btn.className = "bp-sidebar-card__btn bp-sidebar-card__btn--done";
}

export function mountSidebarUi(opts: {
	label: string;
	count: number;
	onSyncRetry: () => void;
	onAutoScroll: () => void;
}): SidebarUiRefs | null {
	const panel = buildSidebarPanel(opts);
	if (!insertIntoSidebar(panel.root)) return null;
	return panel;
}

export function mountSidebarUiWithRetry(
	opts: {
		label: string;
		count: number;
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
	const timeout = setTimeout(() => observer.disconnect(), 15000);

	return () => {
		observer.disconnect();
		clearTimeout(timeout);
	};
}

export function unmountSidebarUi(): void {
	document.getElementById(ROOT_ID)?.remove();
}
