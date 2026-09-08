const RETRY_LABELS = new Set(["retry", "try again", "reload"]);

function normalizeLabel(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isRetryControl(el: Element): boolean {
	const label = normalizeLabel(el.textContent ?? "");
	if (!label || label.length > 40) return false;
	if (RETRY_LABELS.has(label)) return true;
	return label.startsWith("try again");
}

/** Find X's timeline error "Retry" control inside the main column. */
export function findTimelineRetryButton(): HTMLElement | null {
	const col = document.querySelector('[data-testid="primaryColumn"]');
	if (!col) return null;

	for (const selector of ['[data-testid="empty_state_retry"]']) {
		try {
			const el = col.querySelector<HTMLElement>(selector);
			if (el && isVisible(el)) return el;
		} catch {
			/* invalid selector */
		}
	}
	for (const el of col.querySelectorAll<HTMLElement>("[data-testid]")) {
		const id = el.getAttribute("data-testid") ?? "";
		if (!/retry/i.test(id)) continue;
		if (isVisible(el)) return el;
	}

	for (const el of col.querySelectorAll<HTMLElement>(
		"button, [role='button'], a",
	)) {
		if (!isVisible(el)) continue;
		if (isRetryControl(el)) return el;
	}

	return null;
}

function isVisible(el: HTMLElement): boolean {
	const style = getComputedStyle(el);
	return (
		style.display !== "none" &&
		style.visibility !== "hidden" &&
		el.getBoundingClientRect().height > 0
	);
}

/** Click X's Retry button if present. Returns true when a click was attempted. */
export function clickTimelineRetry(): boolean {
	const btn = findTimelineRetryButton();
	if (!btn) return false;
	btn.click();
	return true;
}
