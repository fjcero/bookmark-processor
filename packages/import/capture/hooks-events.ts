/**
 * Capture event bridge between MAIN-world inject script and extension content script.
 */

export const CAPTURE_EVENT = "bp-capture";
export const CAPTURE_QUEUE_KEY = "bp-capture-queue";

export interface CaptureEventDetail {
	url: string;
	method: string;
	capturedAt: string;
	data: unknown;
	request?: {
		headers: Record<string, string>;
		body?: string;
	};
}

const CAPTURE_QUEUE_MAX = 24;

export function enqueueCapture(detail: CaptureEventDetail): void {
	try {
		const raw = sessionStorage.getItem(CAPTURE_QUEUE_KEY);
		const buf: CaptureEventDetail[] = raw ? JSON.parse(raw) : [];
		buf.push(detail);
		while (buf.length > CAPTURE_QUEUE_MAX) {
			buf.shift();
		}
		sessionStorage.setItem(CAPTURE_QUEUE_KEY, JSON.stringify(buf));
	} catch {
		/* quota or private mode */
	}
	document.dispatchEvent(
		new CustomEvent(CAPTURE_EVENT, { detail }),
	);
}

export function drainCaptureQueue(): CaptureEventDetail[] {
	try {
		const raw = sessionStorage.getItem(CAPTURE_QUEUE_KEY);
		if (!raw) return [];
		sessionStorage.removeItem(CAPTURE_QUEUE_KEY);
		const buf = JSON.parse(raw) as CaptureEventDetail[];
		return Array.isArray(buf) ? buf : [];
	} catch {
		return [];
	}
}

export function clearCaptureQueue(): void {
	try {
		sessionStorage.removeItem(CAPTURE_QUEUE_KEY);
	} catch {
		/* ignore */
	}
}
