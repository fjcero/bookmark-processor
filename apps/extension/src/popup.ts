import { clampScrollDelayMs, loadSettings, saveSettings } from "./storage";

const serverUrlInput = document.getElementById("serverUrl") as HTMLInputElement;
const autoSyncInput = document.getElementById("autoSync") as HTMLInputElement;
const scrollDelayInput = document.getElementById(
	"scrollDelayMs",
) as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

function selectedMode(): "api" | "download" {
	const checked = document.querySelector<HTMLInputElement>(
		'input[name="mode"]:checked',
	);
	return checked?.value === "download" ? "download" : "api";
}

async function refreshStatus() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		statusEl.textContent = "No active tab";
		return;
	}
	try {
		const response = await chrome.tabs.sendMessage(tab.id, {
			type: "bp-capture-status",
		});
		if (response?.active) {
			statusEl.textContent = `Capturing on this tab (${response.count ?? 0} tweets)`;
		} else {
			statusEl.textContent = "Capture inactive on this tab";
		}
	} catch {
		statusEl.textContent = "Open x.com bookmarks, likes, or history, then try again";
	}
}

async function init() {
	const settings = await loadSettings();
	serverUrlInput.value = settings.serverUrl;
	autoSyncInput.checked = settings.autoSync;
	scrollDelayInput.value = String(settings.scrollDelayMs);
	for (const input of document.querySelectorAll<HTMLInputElement>(
		'input[name="mode"]',
	)) {
		input.checked = input.value === settings.mode;
	}
	await refreshStatus();
}

saveBtn.addEventListener("click", async () => {
	await saveSettings({
		serverUrl: serverUrlInput.value.trim() || "http://localhost:3000",
		mode: selectedMode(),
		autoSync: autoSyncInput.checked,
		scrollDelayMs: clampScrollDelayMs(Number(scrollDelayInput.value)),
	});
	statusEl.textContent = "Settings saved";
});

toggleBtn.addEventListener("click", async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;
	try {
		const response = await chrome.tabs.sendMessage(tab.id, {
			type: "bp-toggle-capture",
		});
		statusEl.textContent = response?.active
			? `Capture enabled (${response.count ?? 0} tweets)`
			: "Capture disabled";
	} catch {
		statusEl.textContent = "Cannot reach page — reload x.com tab first";
	}
});

void init();
