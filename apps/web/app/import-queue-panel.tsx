"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
	ImportQueueCounts,
	ImportQueueItemDto,
	SyncStatusResponse,
} from "@repo/import";

function statusTone(status: string): string {
	switch (status) {
		case "pending":
			return "text-amber-300";
		case "importing":
		case "processing":
			return "text-violet-300";
		case "imported":
			return "text-emerald-400";
		case "skipped":
			return "text-zinc-400";
		case "failed":
			return "text-red-400";
		case "cancelled":
			return "text-zinc-500";
		default:
			return "text-zinc-300";
	}
}

function formatWhen(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function CountPill({
	label,
	value,
	active,
}: {
	label: string;
	value: number;
	active?: boolean;
}) {
	return (
		<div
			className={`rounded-lg border px-3 py-2 ${
				active
					? "border-violet-500/50 bg-violet-500/10"
					: "border-zinc-800 bg-zinc-900/50"
			}`}
		>
			<div className="font-mono text-[10px] tracking-wide text-zinc-500 uppercase">
				{label}
			</div>
			<div className="mt-0.5 text-lg font-medium">{value}</div>
		</div>
	);
}

export function ImportQueuePanel({
	onCountsChange,
}: {
	onCountsChange?: (counts: ImportQueueCounts) => void;
}) {
	const [items, setItems] = useState<ImportQueueItemDto[]>([]);
	const [counts, setCounts] = useState<ImportQueueCounts | null>(null);
	const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [cancellingId, setCancellingId] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [queueRes, statusRes] = await Promise.all([
				fetch("/api/import/queue?limit=200"),
				fetch("/api/import/status"),
			]);
			if (!queueRes.ok || !statusRes.ok) throw new Error("Failed to load queue");
			const data = (await queueRes.json()) as {
				items: ImportQueueItemDto[];
				counts: ImportQueueCounts;
			};
			setSyncStatus((await statusRes.json()) as SyncStatusResponse);
			setItems(data.items);
			setCounts(data.counts);
			onCountsChange?.(data.counts);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load queue");
		} finally {
			setLoading(false);
		}
	}, [onCountsChange]);

	useEffect(() => {
		void load();
		const timer = window.setInterval(() => void load(), 10_000);
		return () => window.clearInterval(timer);
	}, [load]);

	async function cancelItem(id: string) {
		setCancellingId(id);
		try {
			const res = await fetch(`/api/import/queue/${id}`, { method: "DELETE" });
			if (!res.ok) {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(data.error ?? "Cancel failed");
			}
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Cancel failed");
		} finally {
			setCancellingId(null);
		}
	}

	return (
		<section className="mb-10">
			<div className="mb-6 flex flex-wrap items-end justify-between gap-4">
				<div>
					<p className="font-mono text-xs tracking-[0.2em] text-zinc-500 uppercase">
						Queue
					</p>
					<h2 className="mt-2 text-2xl font-medium tracking-tight">
						Sync and article processing
					</h2>
					<p className="mt-2 max-w-2xl text-sm text-zinc-400">
						Live work reported by the extension. Captured bookmarks upload in
						batches; articles then fetch their full body one at a time.
					</p>
				</div>
				<Link
					href="/"
					className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900"
				>
					Back to library
				</Link>
			</div>

			<ImportWork status={syncStatus} />
			<ArticleWork status={syncStatus} />

			{counts && counts.total > 0 && (
				<h3 className="mb-3 font-mono text-xs tracking-wide text-zinc-500 uppercase">
					Import records
				</h3>
			)}
			{counts && (
				<div className={`${counts.total > 0 ? "mb-6 grid" : "hidden"} grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6`}>
					<CountPill label="Pending" value={counts.pending} active />
					<CountPill label="Importing" value={counts.importing} />
					<CountPill label="Imported" value={counts.imported} />
					<CountPill label="Skipped" value={counts.skipped} />
					<CountPill label="Failed" value={counts.failed} />
					<CountPill label="Cancelled" value={counts.cancelled} />
				</div>
			)}

			{error && <p className="mb-4 text-sm text-red-400">{error}</p>}

			{loading ? (
				<p className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
					Loading queue…
				</p>
			) : items.length > 0 ? (
				<div className="overflow-hidden rounded-xl border border-zinc-800">
					<table className="w-full text-left text-sm">
						<thead className="bg-zinc-900/80 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
							<tr>
								<th className="px-4 py-3 font-medium">Status</th>
								<th className="px-4 py-3 font-medium">Tweet</th>
								<th className="px-4 py-3 font-medium">Preview</th>
								<th className="px-4 py-3 font-medium">Origin</th>
								<th className="px-4 py-3 font-medium">Queued</th>
								<th className="px-4 py-3 font-medium" />
							</tr>
						</thead>
						<tbody>
							{items.map((item) => (
								<tr
									key={item.id}
									className="border-t border-zinc-800 align-top hover:bg-zinc-900/50"
								>
									<td className="px-4 py-3">
										<span
											className={`font-mono text-xs uppercase ${statusTone(item.status)}`}
										>
											{item.status}
										</span>
									</td>
									<td className="px-4 py-3 font-mono text-xs text-zinc-400">
										<a
											href={`https://x.com/i/web/status/${item.externalId}`}
											target="_blank"
											rel="noreferrer"
											className="hover:text-zinc-200"
										>
											{item.externalId}
										</a>
									</td>
									<td className="max-w-md px-4 py-3 text-zinc-300">
										{item.preview ?? (
											<span className="text-zinc-500">Waiting for capture</span>
										)}
									</td>
									<td className="px-4 py-3 font-mono text-[11px] text-zinc-500">
										{item.origin}
									</td>
									<td className="px-4 py-3 text-xs text-zinc-500">
										{formatWhen(item.createdAt)}
									</td>
									<td className="px-4 py-3 text-right">
										{(item.status === "pending" ||
											item.status === "importing") && (
											<button
												type="button"
												disabled={cancellingId === item.id}
												onClick={() => void cancelItem(item.id)}
												className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 hover:bg-zinc-900 disabled:opacity-50"
											>
												{cancellingId === item.id ? "Cancelling…" : "Cancel"}
											</button>
										)}
										{item.itemId && (
											<Link
												href={`/items/${item.itemId}`}
												className="ml-2 text-xs text-violet-300 hover:text-violet-200"
											>
												Open
											</Link>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
		</section>
	);
}

function ImportWork({ status }: { status: SyncStatusResponse | null }) {
	const worker = status?.extension?.importWorker;
	const rows = worker?.items ?? [];
	return (
		<section className="mb-8">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-mono text-xs tracking-wide text-zinc-500 uppercase">
					Tweet imports
				</h3>
				<p className="text-xs text-zinc-500">
					{worker
						? `${worker.pending} queued · ${worker.imported} new · ${worker.skipped} skipped`
						: status?.extensionOnline
							? "Worker idle"
							: "Extension offline"}
				</p>
			</div>
			{rows.length > 0 ? (
				<div className="overflow-hidden rounded-xl border border-zinc-800">
					<ul className="divide-y divide-zinc-800">
						{rows.map((item) => (
							<li
								key={item.externalId}
								className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
							>
								<span className={`w-20 font-mono text-xs uppercase ${statusTone(item.status)}`}>
									{item.status}
								</span>
								<a
									href={`https://x.com/i/status/${item.externalId}`}
									target="_blank"
									rel="noreferrer"
									className="font-mono text-xs text-zinc-300 hover:text-white"
								>
									{item.externalId}
								</a>
								<span className="text-xs text-zinc-500">
									Attempt {item.attempts + 1}
									{item.nextAt && item.nextAt > Date.now()
										? ` · retry ${formatWhen(new Date(item.nextAt).toISOString())}`
										: ""}
								</span>
								{item.lastError && (
									<span className="basis-full pl-24 text-xs text-red-400">
										{item.lastError}
									</span>
								)}
							</li>
						))}
					</ul>
					{(worker?.pending ?? 0) > rows.length && (
						<p className="border-t border-zinc-800 px-4 py-3 text-xs text-zinc-500">
							Showing the next {rows.length} of {worker?.pending} queued tweets.
						</p>
					)}
				</div>
			) : (
				<p className="rounded-xl border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
					No tweets are waiting in the background import worker.
				</p>
			)}
		</section>
	);
}

function ArticleWork({ status }: { status: SyncStatusResponse | null }) {
	const extension = status?.extension;
	const queue = extension?.articleQueue ?? [];

	return (
		<section className="mb-8">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-mono text-xs tracking-wide text-zinc-500 uppercase">
					Article bodies
				</h3>
				<p className="text-xs text-zinc-500">
					{status?.extensionOnline
						? `${extension?.articles.pending ?? 0} pending · ${extension?.articles.fetching ?? 0} fetching · ${extension?.articles.failed ?? 0} failed`
						: "Extension offline"}
				</p>
			</div>
			<p className="mb-3 text-sm text-zinc-400">
				The extension opens or requests one article at a time, waits between
				requests to avoid X rate limits, then uploads the full article body.
			</p>
			{queue.length === 0 ? (
				<p className="rounded-xl border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">
					{status?.extensionOnline
						? "No article bodies are queued in the extension."
						: "Open X with the extension enabled to see its article queue."}
				</p>
			) : (
				<div className="overflow-hidden rounded-xl border border-zinc-800">
					<ul className="divide-y divide-zinc-800">
						{queue.map((item) => (
							<li
								key={item.articleId}
								className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
							>
								<span className={`w-16 font-mono text-xs uppercase ${statusTone(item.status)}`}>
									{item.status}
								</span>
								<a
									href={item.url}
									target="_blank"
									rel="noreferrer"
									className="font-mono text-xs text-zinc-300 hover:text-white"
								>
									Article {item.articleId}
								</a>
								<span className="text-xs text-zinc-500">
									Attempt {item.attempts}
									{item.nextAt && item.nextAt > Date.now()
										? ` · retry ${formatWhen(new Date(item.nextAt).toISOString())}`
										: ""}
								</span>
								{item.lastError && (
									<span className="basis-full pl-20 text-xs text-red-400">
										{item.lastError}
									</span>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
