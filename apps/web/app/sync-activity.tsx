"use client";

import type { SyncStatusResponse } from "@repo/import";

function QueueStat({
	label,
	value,
	hint,
	warn,
}: {
	label: string;
	value: number | string;
	hint: string;
	warn?: boolean;
}) {
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-3">
			<div className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
				{label}
			</div>
			<div
				className={`mt-1 text-xl font-medium ${warn ? "text-amber-300" : ""}`}
			>
				{value}
			</div>
			<p className="mt-1 text-xs leading-snug text-zinc-500">{hint}</p>
		</div>
	);
}

function formatAgo(iso: string | undefined): string {
	if (!iso) return "never";
	const ms = Date.now() - Date.parse(iso);
	if (!Number.isFinite(ms) || ms < 0) return "just now";
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	return `${Math.round(ms / 3_600_000)}h ago`;
}

export function SyncActivity({
	status,
}: {
	status: SyncStatusResponse | null;
}) {
	if (!status) {
		return (
			<section className="mb-8 rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-4">
				<h2 className="font-mono text-xs tracking-wide text-zinc-500 uppercase">
					Sync
				</h2>
				<p className="mt-2 text-sm text-zinc-500">Loading sync status…</p>
			</section>
		);
	}

	const ext = status.extension;
	const lib = status.library;
	const extensionLabel = status.extensionOnline ? "online" : "offline";

	return (
		<section className="mb-8 rounded-xl border border-zinc-800 bg-zinc-950/40 px-4 py-4">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2 className="font-mono text-xs tracking-wide text-zinc-500 uppercase">
					Sync
				</h2>
				<p className="font-mono text-[11px] text-zinc-600">
					Extension {extensionLabel}
					{ext?.reportedAt ? ` · seen ${formatAgo(ext.reportedAt)}` : ""}
				</p>
			</div>

			<div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<QueueStat
					label="Library · missing article body"
					value={lib.articlesNeedingBody}
					hint="Articles in the library waiting for full text from X."
					warn={lib.articlesNeedingBody > 0}
				/>
				<QueueStat
					label="Library · refetch queued"
					value={lib.articlesRefetchQueued}
					hint="You asked the extension to capture these again."
					warn={lib.articlesRefetchQueued > 0}
				/>
				<QueueStat
					label="Capture · pending upload"
					value={status.extensionOnline ? (ext?.capturedUnsynced ?? 0) : "—"}
					hint="Captured bookmarks currently waiting for the next upload batch."
					warn={Boolean(ext && ext.capturedUnsynced > 0)}
				/>
				<QueueStat
					label="Import worker · queued"
					value={status.extensionOnline ? (ext?.importWorker?.pending ?? 0) : "—"}
					hint={
						ext?.importWorker?.processingId
							? "Importing one tweet now; remaining work is persisted in the service worker."
							: "Tweets persisted for sequential background import."
					}
					warn={Boolean(ext?.importWorker?.lastError)}
				/>
				<QueueStat
					label="Extension · upload retry"
					value={
						status.extensionOnline
							? ext?.pendingUpload
								? (ext.pendingUploadCount ?? 1)
								: 0
							: "—"
					}
					hint="Failed uploads waiting for the extension to retry."
					warn={Boolean(ext?.pendingUpload)}
				/>
				<QueueStat
					label="Extension · articles pending"
					value={status.extensionOnline ? (ext?.articles.pending ?? 0) : "—"}
					hint="Article bodies queued in the extension worker."
					warn={Boolean(ext && ext.articles.pending > 0)}
				/>
				<QueueStat
					label="Extension · articles fetching"
					value={status.extensionOnline ? (ext?.articles.fetching ?? 0) : "—"}
					hint="Articles the extension is loading from X right now."
					warn={Boolean(ext && ext.articles.fetching > 0)}
				/>
			</div>

			{(ext?.timelineRunning || ext?.captureScrollActive) && (
				<p className="mt-3 font-mono text-[11px] text-violet-300/90">
					{ext.timelineRunning
						? `History pagination running · ${ext.timelineCaptured ?? 0} loaded`
						: "Bookmarks tab is auto-scrolling"}
				</p>
			)}

			{status.revocations.length > 0 && (
				<p className="mt-3 text-xs text-zinc-500">
					{status.revocations.length} archived item
					{status.revocations.length === 1 ? "" : "s"} waiting for the extension
					to drop from its local queues.
				</p>
			)}
		</section>
	);
}
