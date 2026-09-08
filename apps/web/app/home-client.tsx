"use client";

import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ActivitySeries } from "@/lib/activity-types";
import type { EmbeddedTweet } from "@/lib/embeds";
import { ITEMS_PAGE_SIZE } from "@/lib/items-config";
import type { ImportPrefs, ItemSort, ViewMode } from "@/lib/import-prefs";
import { type ClientItem } from "@/lib/item-dto";
import ActivityHeatmap from "./activity-heatmap";
import ItemSearchBar, { type ItemSearchState } from "./item-search-bar";
import {
	ArticleBody,
	articleContentHasInlineMedia,
} from "./article-body";
import { SyncActivity } from "./sync-activity";
import { ImportQueuePanel } from "./import-queue-panel";
import type { SyncStatusResponse } from "@repo/import";
import Link from "next/link";

export interface StageCounts {
	done: number;
	pending: number;
}

export interface BucketStats {
	total: number;
	raw: StageCounts;
	entities: StageCounts;
	understanding: StageCounts;
	categorized: StageCounts;
}

export interface Stats {
	users: number;
	items: number;
	archived: number;
	posts: BucketStats;
	articles: BucketStats;
	entities: StageCounts;
	understanding: StageCounts;
	categorized: StageCounts;
}

interface ImportResult {
	filename: string;
	parsed: { users: number; items: number };
	users: { imported: number; skipped: number };
	items: { imported: number; skipped: number };
	files?: Array<{
		filename: string;
		items: { imported: number; skipped: number };
		error?: string;
	}>;
	errors?: string[];
	processing?: boolean;
}

function jsonFiles(list: FileList | File[]): File[] {
	return [...list].filter(
		(f) =>
			f.name.toLowerCase().endsWith(".json") || f.type === "application/json",
	);
}

function searchActive(search: ItemSearchState): boolean {
	return Boolean(
		search.q.trim() || search.contentType || search.postFormat,
	);
}

function buildItemsQuery({
	limit,
	offset,
	search,
	sort,
}: {
	limit: number;
	offset: number;
	search: ItemSearchState;
	sort: ItemSort;
}): string {
	const params = new URLSearchParams({
		limit: String(limit),
		offset: String(offset),
		sort,
	});
	const q = search.q.trim();
	if (q) params.set("q", q);
	if (search.contentType) params.set("contentType", search.contentType);
	if (search.postFormat) params.set("postFormat", search.postFormat);
	return `/api/items?${params}`;
}

interface ProcessState {
	status: "idle" | "running" | "stopping";
	stage: "entities" | "understanding" | "categorize" | null;
	done: number;
	total: number;
	stageCounts: { entities: number; understanding: number; categorized: number };
	lastError: string | null;
	error: string | null;
}

export type { ClientItem };

function itemUrl(item: ClientItem): string | null {
	if (item.url) return item.url;
	if (item.source === "x" && item.externalId) {
		return item.handle
			? `https://x.com/${item.handle}/status/${item.externalId}`
			: `https://x.com/i/status/${item.externalId}`;
	}
	return null;
}

function profileUrl(item: ClientItem): string | null {
	if (!item.handle) return null;
	if (item.source === "x") return `https://x.com/${item.handle}`;
	return null;
}

function articleDisplay(item: ClientItem): { title: string; rest: string } {
	const title =
		item.articleTitle?.trim() || item.text.split(/\n\n/)[0] || "";
	if (item.articleTitle && item.text.startsWith(item.articleTitle)) {
		return { title, rest: item.text.slice(item.articleTitle.length).trim() };
	}
	const parts = item.text.split(/\n\n+/);
	return { title: parts[0] ?? "", rest: parts.slice(1).join("\n\n") };
}

function TypeBadges({ item }: { item: ClientItem }) {
	const contentLabel = item.contentType === "article" ? "Article" : "Post";
	const formatLabel =
		item.postFormat && item.postFormat !== "original"
			? { reply: "Reply", quote: "Quote", repost: "Repost", thread: "Thread" }[
					item.postFormat
				]
			: null;
	return (
		<div className="flex flex-wrap gap-1">
			<span
				className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${
					item.contentType === "article"
						? "bg-amber-500/15 text-amber-300"
						: "bg-zinc-800 text-zinc-400"
				}`}
			>
				{contentLabel}
			</span>
			{formatLabel && (
				<span className="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-[10px] tracking-wide text-zinc-400 uppercase">
					{formatLabel}
				</span>
			)}
		</div>
	);
}

function ItemTextPreview({
	item,
	lines = 6,
}: {
	item: ClientItem;
	lines?: number;
}) {
	if (item.contentType === "article") {
		const { title, rest } = articleDisplay(item);
		return (
			<div>
				<p className="text-sm font-medium text-zinc-100">{title || "(untitled)"}</p>
				{rest ? (
					<p
						className={`mt-1 text-sm text-zinc-400 ${
							lines <= 3 ? "line-clamp-2" : "line-clamp-4"
						}`}
					>
						{rest}
					</p>
				) : null}
				{item.articleRefetching ? (
					<p className="mt-1 font-mono text-[11px] text-violet-400/80">
						Refetching from X
					</p>
				) : !item.articleHydrated ? (
					<p className="mt-1 font-mono text-[11px] text-zinc-600">
						Full text pending
					</p>
				) : null}
			</div>
		);
	}
	return (
		<p className={`text-sm text-zinc-300 ${lines <= 3 ? "line-clamp-3" : "line-clamp-6"}`}>
			{item.text || "(empty)"}
		</p>
	);
}

const STAGE_LABEL: Record<NonNullable<ProcessState["stage"]>, string> = {
	entities: "Extracting entities",
	understanding: "LLM understanding",
	categorize: "Categorizing",
};

export default function HomeClient({
	initialStats,
	initialActivity,
	initialItems,
	initialHasMore,
	initialImportPrefs,
	initialView,
	initialSort,
}: {
	initialStats: Stats;
	initialActivity: ActivitySeries;
	initialItems: ClientItem[];
	initialHasMore: boolean;
	initialImportPrefs: ImportPrefs;
	initialView: ViewMode;
	initialSort: ItemSort;
}) {
	const [stats, setStats] = useState<Stats>(initialStats);
	const [activity, setActivity] = useState<ActivitySeries>(initialActivity);
	const [items, setItems] = useState<ClientItem[]>(initialItems);
	const [hasMore, setHasMore] = useState(initialHasMore);
	const [loadingMore, setLoadingMore] = useState(false);
	const [prefs, setPrefs] = useState<ImportPrefs>(initialImportPrefs);
	const [view, setView] = useState<ViewMode>(initialView);
	const [sort, setSort] = useState<ItemSort>(initialSort);
	const [importResult, setImportResult] = useState<ImportResult | null>(null);
	const [importError, setImportError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(false);
	const [processState, setProcessState] = useState<ProcessState | null>(null);
	const [refetchNotice, setRefetchNotice] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const router = useRouter();
	const pathname = usePathname();
	const selectedId = pathname.match(/^\/items\/([^/]+)$/)?.[1] ?? null;
	const onQueuePage = pathname === "/queue";
	const [fetchedSelected, setFetchedSelected] = useState<ClientItem | null>(
		null,
	);
	const [search, setSearch] = useState<ItemSearchState>({
		q: "",
	});
	const [resultTotal, setResultTotal] = useState<number | null>(null);
	const [searching, setSearching] = useState(false);
	const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const importPopoverRef = useRef<HTMLDivElement>(null);
	const loadMoreRef = useRef<HTMLDivElement>(null);
	const loadingMoreRef = useRef(false);
	const selectedIndex = items.findIndex((item) => item.id === selectedId);
	const selected =
		(selectedIndex >= 0 ? items[selectedIndex] : null) ??
		(fetchedSelected?.id === selectedId ? fetchedSelected : null);

	const loadMore = useCallback(async () => {
		if (loadingMoreRef.current || !hasMore) return;
		loadingMoreRef.current = true;
		setLoadingMore(true);
		try {
			const res = await fetch(
				buildItemsQuery({
					limit: ITEMS_PAGE_SIZE,
					offset: items.length,
					search,
					sort,
				}),
			);
			if (!res.ok) return;
			const data = (await res.json()) as {
				items: ClientItem[];
				total: number;
			};
			const batch = data.items;
			if (batch.length === 0) {
				setHasMore(false);
				return;
			}
			const seen = new Set(items.map((item) => item.id));
			const unique = batch.filter((item) => !seen.has(item.id));
			const nextLength = items.length + unique.length;
			setItems((prev) => (unique.length > 0 ? [...prev, ...unique] : prev));
			setResultTotal(data.total);
			setHasMore(nextLength < data.total);
		} finally {
			loadingMoreRef.current = false;
			setLoadingMore(false);
		}
	}, [hasMore, items, search, sort]);

	const refresh = useCallback(async () => {
		const [statsRes, itemsRes, activityRes, syncRes] = await Promise.all([
			fetch("/api/stats"),
			fetch(
				buildItemsQuery({
					limit: ITEMS_PAGE_SIZE,
					offset: 0,
					search,
					sort,
				}),
			),
			fetch("/api/activity"),
			fetch("/api/import/status"),
		]);
		if (statsRes.ok) setStats((await statsRes.json()) as Stats);
		if (activityRes.ok) setActivity(await activityRes.json());
		if (syncRes.ok) setSyncStatus((await syncRes.json()) as SyncStatusResponse);
		if (itemsRes.ok) {
			const data = (await itemsRes.json()) as {
				items: ClientItem[];
				total: number;
			};
			setItems(data.items);
			setResultTotal(data.total);
			setHasMore(data.items.length < data.total);
		}
	}, [search, sort]);

	useEffect(() => {
		let cancelled = false;
		const load = async () => {
			const res = await fetch("/api/import/status");
			if (!res.ok || cancelled) return;
			setSyncStatus((await res.json()) as SyncStatusResponse);
		};
		void load();
		const timer = window.setInterval(() => void load(), 10_000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		const timer = window.setTimeout(() => {
			void (async () => {
				setSearching(true);
				try {
					const res = await fetch(
						buildItemsQuery({
							limit: ITEMS_PAGE_SIZE,
							offset: 0,
							search,
							sort,
						}),
					);
					if (!res.ok) return;
					const data = (await res.json()) as {
						items: ClientItem[];
						total: number;
					};
					setItems(data.items);
					setResultTotal(data.total);
					setHasMore(data.items.length < data.total);
				} finally {
					setSearching(false);
				}
			})();
		}, 300);
		return () => window.clearTimeout(timer);
	}, [search, sort]);

	useEffect(() => {
		const el = loadMoreRef.current;
		if (!el || !hasMore) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) void loadMore();
			},
			{ rootMargin: "400px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, loadMore]);

	const watchProcess = useCallback(() => {
		const source = new EventSource("/api/process");
		source.onmessage = (event) => {
			const state = JSON.parse(event.data) as ProcessState;
			setProcessState(state);
			if (state.status === "idle") {
				source.close();
				void refresh();
			}
		};
		source.onerror = () => {
			source.close();
			void refresh();
		};
	}, [refresh]);

	const openItem = useCallback(
		(id: string) => {
			if (id === selectedId) return;
			router.push(`/items/${id}`, { scroll: false });
		},
		[router, selectedId],
	);

	const closeSheet = useCallback(() => {
		router.push("/", { scroll: false });
	}, [router]);

	const moveSelection = useCallback(
		(delta: number) => {
			if (items.length === 0) return;
			const current = items.findIndex((item) => item.id === selectedId);
			const from = current === -1 ? (delta > 0 ? -1 : 0) : current;
			const next = Math.min(items.length - 1, Math.max(0, from + delta));
			const nextId = items[next].id;
			if (nextId === selectedId) return;
			router.replace(`/items/${nextId}`, { scroll: false });
			requestAnimationFrame(() => {
				document.querySelector(`[data-item-id="${nextId}"]`)?.scrollIntoView({
					block: "nearest",
				});
			});
		},
		[items, router, selectedId],
	);

	useEffect(() => {
		if (!selectedId) {
			setFetchedSelected(null);
			return;
		}
		if (items.some((item) => item.id === selectedId)) {
			setFetchedSelected(null);
			return;
		}
		if (fetchedSelected?.id === selectedId) return;
		let cancelled = false;
		void fetch(`/api/items/${selectedId}`)
			.then(async (res) => {
				if (!res.ok) {
					if (!cancelled) router.replace("/", { scroll: false });
					return;
				}
				const item = (await res.json()) as ClientItem;
				if (!cancelled) setFetchedSelected(item);
			})
			.catch(() => {
				if (!cancelled) router.replace("/", { scroll: false });
			});
		return () => {
			cancelled = true;
		};
	}, [fetchedSelected?.id, items, router, selectedId]);

	useEffect(() => {
		if (!importOpen) return;
		function onPointerDown(event: MouseEvent) {
			const target = event.target as Node;
			if (
				importPopoverRef.current &&
				!importPopoverRef.current.contains(target)
			) {
				setImportOpen(false);
			}
		}
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [importOpen]);

	useEffect(() => {
		if (!importOpen && !settingsOpen) return;
		function onKey(event: KeyboardEvent) {
			if (event.key !== "Escape" || selectedId) return;
			setImportOpen(false);
			setSettingsOpen(false);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [importOpen, settingsOpen, selectedId]);

	async function persistPrefs(next: ImportPrefs) {
		setPrefs(next);
		try {
			await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ import: next }),
			});
		} catch {
			/* keep local prefs even if persist fails */
		}
	}

	async function uploadFiles(files: File[]) {
		const jsonOnly = jsonFiles(files);
		if (jsonOnly.length === 0) {
			setImportError("No JSON export files selected");
			return;
		}

		setUploading(true);
		setImportError(null);
		setImportResult(null);
		const form = new FormData();
		for (const file of jsonOnly) form.append("file", file);
		form.append("entities", String(prefs.entities));
		form.append("understanding", String(prefs.understanding));
		form.append("categorize", String(prefs.categorize));
		try {
			const res = await fetch("/api/import", { method: "POST", body: form });
			const data = await res.json();
			if (!res.ok) {
				setImportError(data.error ?? "Import failed");
				if (data.files) setImportResult(data as ImportResult);
				return;
			}
			setImportResult(data as ImportResult);
			await refresh();
			if (data.processing) watchProcess();
			setImportOpen(true);
		} catch (err) {
			setImportError(err instanceof Error ? err.message : "Import failed");
		} finally {
			setUploading(false);
			if (fileRef.current) fileRef.current.value = "";
		}
	}

	async function startProcess(opts: {
		force?: boolean;
		stages?: Array<"entities" | "understanding" | "categorize">;
		itemIds?: string[];
		model?: string;
		refetch?: boolean;
	} = {}) {
		const res = await fetch("/api/process", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts),
		});
		const data = (await res.json().catch(() => ({}))) as {
			error?: string;
			status?: string;
			refetchQueued?: number;
		};
		if (typeof data.refetchQueued === "number") {
			if (data.refetchQueued > 0) {
				setRefetchNotice(
					data.refetchQueued === 1
						? "Queued 1 article for the extension to capture again."
						: `Queued ${data.refetchQueued} articles for the extension to capture again.`,
				);
				void refresh();
			} else if (opts.refetch) {
				setRefetchNotice("No articles to refetch in this scope.");
			}
		}
		if (!res.ok) {
			setProcessState((prev) => ({
				...(prev ?? {
					status: "idle",
					stage: null,
					done: 0,
					total: 0,
					stageCounts: { entities: 0, understanding: 0, categorized: 0 },
					lastError: null,
					error: null,
				}),
				error: data.error ?? "Failed to start",
			}));
			return;
		}
		if (data.status === "running") watchProcess();
	}

	async function persistView(next: ViewMode) {
		setView(next);
		try {
			await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ view: next }),
			});
		} catch {
			/* keep local view even if persist fails */
		}
	}

	async function persistSort(next: ItemSort) {
		if (next === sort) return;
		setSort(next);
		try {
			await fetch("/api/settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sort: next }),
			});
		} catch {
			/* keep local sort even if persist fails */
		}
	}

	async function deleteItem(id: string) {
		if (
			!confirm(
				"Remove this bookmark from the list? It will be archived, not deleted.",
			)
		)
			return;
		const res = await fetch(`/api/items/${id}`, { method: "DELETE" });
		if (!res.ok) return;
		const index = items.findIndex((item) => item.id === id);
		const remaining = items.filter((item) => item.id !== id);
		setItems(remaining);
		if (selectedId === id) {
			const neighbor = remaining[index] ?? remaining[index - 1];
			if (neighbor) router.replace(`/items/${neighbor.id}`, { scroll: false });
			else router.replace("/", { scroll: false });
		}
		await refresh();
	}

	useEffect(() => {
		if (!selectedId) return;
		const activeId = selectedId;
		function onKey(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			const typing =
				target &&
				(target.tagName === "INPUT" ||
					target.tagName === "TEXTAREA" ||
					target.tagName === "SELECT" ||
					target.isContentEditable);
			if (event.key === "Escape") {
				event.preventDefault();
				closeSheet();
				return;
			}
			if (
				(event.metaKey || event.ctrlKey) &&
				(event.key === "Backspace" || event.key === "Delete")
			) {
				if (typing) return;
				event.preventDefault();
				void deleteItem(activeId);
				return;
			}
			if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
			const key = event.key.toLowerCase();
			if (event.key === "ArrowDown" || key === "j") {
				event.preventDefault();
				moveSelection(1);
			} else if (event.key === "ArrowUp" || key === "k") {
				event.preventDefault();
				moveSelection(-1);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selectedId, closeSheet, moveSelection, items, router, refresh]);

	return (
		<div>
			<main className="mx-auto max-w-6xl px-6 py-10">
				<header className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<p className="font-mono text-xs tracking-[0.2em] text-zinc-500 uppercase">
							Bookmark export v2
						</p>
						<h1 className="mt-2 text-3xl font-medium tracking-tight">
							Bookmark Processor
						</h1>
						<p className="mt-2 max-w-xl text-sm text-zinc-400">
							Import bookmark exports and run processing when you are ready.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2 self-start">
						<Link
							href="/queue"
							className={`relative rounded-md border px-3 py-2 text-sm hover:bg-zinc-900 ${
								onQueuePage
									? "border-violet-500/60 text-violet-200"
									: "border-zinc-700 text-zinc-200 hover:border-zinc-500"
							}`}
						>
							Queue
							{(syncStatus?.library.importQueue.pending ?? 0) > 0 && (
								<span className="absolute -top-1.5 -right-1.5 min-w-[1.1rem] rounded-full bg-amber-400 px-1 text-center font-mono text-[10px] font-semibold text-zinc-950">
									{syncStatus!.library.importQueue.pending}
								</span>
							)}
						</Link>
						<div className="relative" ref={importPopoverRef}>
							<button
								type="button"
								onClick={() => setImportOpen((open) => !open)}
								className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900"
							>
								Import
							</button>
							{importOpen && (
								<div
									className="absolute right-0 z-30 mt-2 w-80 rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-2xl"
									onDragOver={(e) => {
										e.preventDefault();
										setDragOver(true);
									}}
									onDragLeave={() => setDragOver(false)}
									onDrop={(e) => {
										e.preventDefault();
										setDragOver(false);
										const dropped = jsonFiles(e.dataTransfer.files);
										if (dropped.length > 0) void uploadFiles(dropped);
									}}
								>
									<p className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
										Upload export
									</p>
									<div
										className={`mt-3 rounded-lg border border-dashed px-4 py-6 text-center transition ${
											dragOver
												? "border-violet-400 bg-violet-500/10"
												: "border-zinc-700 bg-zinc-900/60"
										}`}
									>
										<p className="text-xs text-zinc-400">
											Drop JSON here, or
										</p>
										<button
											type="button"
											onClick={() => fileRef.current?.click()}
											disabled={uploading}
											className="mt-2 rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
										>
											{uploading ? "Importing…" : "Choose files"}
										</button>
										<input
											ref={fileRef}
											type="file"
											accept="application/json,.json"
											multiple
											className="hidden"
											onChange={(e) => {
												const picked = e.target.files;
												if (picked && picked.length > 0)
													void uploadFiles([...picked]);
											}}
										/>
									</div>
									{importResult && (
										<div className="mt-3 space-y-1 font-mono text-[11px] text-emerald-400">
											<p>
												{importResult.filename}: {importResult.items.imported}{" "}
												imported, {importResult.items.skipped} skipped
											</p>
											{importResult.files && importResult.files.length > 1 && (
												<ul className="text-left text-zinc-500">
													{importResult.files.map((f) => (
														<li key={f.filename}>
															{f.filename}: {f.items.imported} new
															{f.error ? ` · ${f.error}` : ""}
														</li>
													))}
												</ul>
											)}
										</div>
									)}
									{importError && (
										<p className="mt-3 text-xs text-red-400">{importError}</p>
									)}
								</div>
							)}
						</div>
						<button
							type="button"
							onClick={() => setSettingsOpen(true)}
							className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-900"
						>
							Settings
						</button>
						<ProcessMenu
							prefs={prefs}
							itemId={selectedId}
							running={processState?.status === "running"}
							menuSide="right"
							needsArticleCapture={
								selected?.contentType === "article" &&
								selected.articleHydrated !== true
							}
							onRun={(opts) => void startProcess(opts)}
						/>
					</div>
				</header>

				{settingsOpen && (
					<SettingsModal
						prefs={prefs}
						uploading={uploading}
						onClose={() => setSettingsOpen(false)}
						onChange={(next) => void persistPrefs(next)}
					/>
				)}

				<section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
					<ContentStat label="Posts" bucket={stats.posts} />
					<ContentStat label="Articles" bucket={stats.articles} showRaw />
					<TotalStat items={stats.items} archived={stats.archived} />
					<Stat label="Authors" value={stats.users} />
				</section>

				{onQueuePage ? (
					<>
						<SyncActivity status={syncStatus} />
						<ImportQueuePanel />
					</>
				) : (
					<>
				<ActivityHeatmap series={activity} />

				<ItemSearchBar
					value={search}
					onChange={setSearch}
					view={view}
					onViewChange={(next) => void persistView(next)}
					sort={sort}
					onSortChange={(next) => void persistSort(next)}
					resultCount={
						searchActive(search) && !searching ? resultTotal : null
					}
					loading={searching}
				/>

				{(processState?.status === "running" && processState.stage) ||
				processState?.error ||
				processState?.lastError ||
				refetchNotice ? (
					<section className="mb-6 space-y-1">
						{processState?.status === "running" && processState.stage && (
							<p className="font-mono text-xs text-zinc-400">
								{STAGE_LABEL[processState.stage]} · {processState.done}/
								{processState.total}
							</p>
						)}
						{processState?.error && (
							<p className="text-sm text-red-400">{processState.error}</p>
						)}
						{processState?.lastError && !processState.error && (
							<p className="text-sm text-amber-400">{processState.lastError}</p>
						)}
						{refetchNotice && (
							<p className="text-sm text-violet-300">{refetchNotice}</p>
						)}
					</section>
				) : null}

				{items.length === 0 ? (
					<p className="rounded-xl border border-zinc-800 px-4 py-10 text-center text-sm text-zinc-500">
						{searchActive(search)
							? "No matches. Try different keywords or filters."
							: "No items yet. Upload an export to get started."}
					</p>
				) : view === "grid" ? (
					<section
						className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
					>
						{items.map((item) => (
							<article
								key={item.id}
								data-item-id={item.id}
								onClick={() => openItem(item.id)}
								className={`flex cursor-pointer flex-col rounded-xl border bg-zinc-900/40 p-4 ${
									selectedId === item.id
										? "border-violet-400 ring-1 ring-violet-400/40"
										: "border-zinc-800 hover:border-zinc-600"
								}`}
							>
								<div className="mb-3 flex items-start justify-between gap-2">
									<div className="min-w-0">
										<Author item={item} />
									</div>
									<TypeBadges item={item} />
								</div>
								<div className="flex-1">
									<ItemTextPreview item={item} />
								</div>
								{(item.embeds?.length ?? 0) > 0 && (
									<EmbeddedTweetList embeds={item.embeds ?? []} compact className="mt-3" />
								)}
								<ItemMedia urls={item.mediaUrls} className="mt-3" compact />
								<div className="mt-3 flex items-end justify-between gap-2">
									<div className="flex min-w-0 flex-1 flex-wrap gap-1">
										<CategoryBadges item={item} />
									</div>
									<ItemDate item={item} sort={sort} />
								</div>
							</article>
						))}
					</section>
				) : (
					<section className="overflow-hidden rounded-xl border border-zinc-800">
						<table className="w-full text-left text-sm">
							<thead className="bg-zinc-900/80 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
								<tr>
									<th className="px-4 py-3 font-medium">Author</th>
									<th className="px-4 py-3 font-medium">Date</th>
									<th className="px-4 py-3 font-medium">Type</th>
									<th className="px-4 py-3 font-medium">Text</th>
									<th className="px-4 py-3 font-medium">Categories</th>
								</tr>
							</thead>
							<tbody>
								{items.map((item) => (
									<tr
										key={item.id}
										data-item-id={item.id}
										onClick={() => openItem(item.id)}
										className={`cursor-pointer border-t border-zinc-800 align-top ${
											selectedId === item.id
												? "bg-violet-500/10"
												: "hover:bg-zinc-900/70"
										}`}
									>
										<td className="px-4 py-3 whitespace-nowrap">
											<Author item={item} />
										</td>
										<td className="px-4 py-3 whitespace-nowrap">
											<ItemDate item={item} sort={sort} />
										</td>
										<td className="px-4 py-3">
											<TypeBadges item={item} />
										</td>
										<td className="px-4 py-3 text-zinc-300">
											<ItemTextPreview item={item} lines={3} />
											{(item.embeds?.length ?? 0) > 0 && (
												<EmbeddedTweetList
													embeds={item.embeds ?? []}
													compact
													className="mt-2 max-w-xl"
												/>
											)}
											<ItemMedia
												urls={item.mediaUrls}
												className="mt-2"
												compact
											/>
										</td>
										<td className="px-4 py-3">
											<div className="flex flex-wrap gap-1">
												<CategoryBadges item={item} />
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				)}

				{items.length > 0 && (
					<div ref={loadMoreRef} className="py-8 text-center">
						{loadingMore && (
							<p className="font-mono text-xs text-zinc-500">Loading more…</p>
						)}
						{!hasMore && !loadingMore && (
							<p className="font-mono text-xs text-zinc-600">
								{searchActive(search) && resultTotal !== null
									? `Showing all ${items.length} of ${resultTotal} matches`
									: `All ${items.length} items loaded`}
							</p>
						)}
					</div>
				)}
					</>
				)}
			</main>
			{selected && (
				<ItemSheet
					item={selected}
					index={selectedIndex >= 0 ? selectedIndex : 0}
					total={selectedIndex >= 0 ? items.length : 1}
					prefs={prefs}
					processing={processState?.status === "running"}
					onClose={closeSheet}
					onPrev={() => moveSelection(-1)}
					onNext={() => moveSelection(1)}
					onDelete={() => void deleteItem(selected.id)}
					onProcess={(opts) => void startProcess(opts)}
				/>
			)}
		</div>
	);
}

function itemDisplayDate(
	item: ClientItem,
	sort: ItemSort,
): { iso: string; text: string } {
	const iso =
		sort === "published"
			? item.publishedAt ?? item.importedAt
			: item.importedAt;
	return {
		iso,
		text: new Date(iso).toLocaleDateString(undefined, {
			dateStyle: "medium",
		}),
	};
}

function ItemDate({
	item,
	sort,
	className = "",
}: {
	item: ClientItem;
	sort: ItemSort;
	className?: string;
}) {
	const { iso, text } = itemDisplayDate(item, sort);
	return (
		<time
			dateTime={iso}
			className={`shrink-0 font-mono text-[11px] text-zinc-500 ${className}`}
		>
			{text}
		</time>
	);
}

function Author({
	item,
	linkProfile = false,
}: {
	item: ClientItem;
	linkProfile?: boolean;
}) {
	const profile = linkProfile ? profileUrl(item) : null;
	const content = (
		<>
			{item.avatarUrl ? (
				<img
					src={item.avatarUrl}
					alt=""
					className="size-8 shrink-0 rounded-full bg-zinc-800 object-cover"
				/>
			) : (
				<span className="size-8 shrink-0 rounded-full bg-zinc-800" />
			)}
			<span className="min-w-0">
				<span className="block truncate font-medium">{item.name}</span>
				<span className="block truncate font-mono text-xs text-zinc-500">
					@{item.handle}
				</span>
			</span>
		</>
	);

	if (!profile) {
		return <div className="flex min-w-0 items-center gap-2">{content}</div>;
	}

	return (
		<a
			href={profile}
			target="_blank"
			rel="noreferrer"
			className="flex min-w-0 items-center gap-2 rounded-md hover:bg-zinc-900/60"
		>
			{content}
		</a>
	);
}

function CategoryBadges({ item }: { item: ClientItem }) {
	return (
		<>
			{item.categories.map((c) => (
				<span
					key={c.slug}
					className="rounded-full px-2 py-0.5 text-[11px]"
					style={{ background: `${c.color}22`, color: c.color }}
				>
					{c.name}
				</span>
			))}
		</>
	);
}

type ProcessScope = "pending" | "item" | "all";
type ProcessStage = "entities" | "understanding" | "categorize";
type ProcessModel = "haiku" | "sonnet" | "opus";

interface ProcessRunOptions {
	force?: boolean;
	stages?: ProcessStage[];
	itemIds?: string[];
	model?: ProcessModel;
	refetch?: boolean;
}

const PROCESS_STAGE_OPTIONS: Array<{
	id: ProcessStage;
	label: string;
	hint: string;
}> = [
	{ id: "entities", label: "Extract entities", hint: "Free. Handles, URLs, dates." },
	{ id: "understanding", label: "LLM understanding", hint: "Summary and tags." },
	{ id: "categorize", label: "Categorize with AI", hint: "Assign library categories." },
];

const PROCESS_MODEL_OPTIONS: Array<{
	id: ProcessModel;
	label: string;
	hint: string;
}> = [
	{ id: "haiku", label: "Haiku", hint: "Fast and cheap" },
	{ id: "sonnet", label: "Sonnet", hint: "Stronger reasoning" },
	{ id: "opus", label: "Opus", hint: "Highest quality" },
];

function ProcessMenu({
	prefs,
	itemId,
	running,
	onRun,
	compact = false,
	align = "down",
	menuSide = "left",
	needsArticleCapture = false,
}: {
	prefs: ImportPrefs;
	itemId?: string | null;
	running: boolean;
	onRun: (opts: ProcessRunOptions) => void;
	compact?: boolean;
	align?: "down" | "up";
	menuSide?: "left" | "right";
	needsArticleCapture?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [scope, setScope] = useState<ProcessScope>(itemId ? "item" : "pending");
	const [stages, setStages] = useState<Record<ProcessStage, boolean>>(() => {
		const next = {
			entities: prefs.entities,
			understanding: prefs.understanding,
			categorize: prefs.categorize,
		};
		if (!next.entities && !next.understanding && !next.categorize) {
			next.entities = true;
		}
		return next;
	});
	const [model, setModel] = useState<ProcessModel>("haiku");
	const [refetch, setRefetch] = useState(needsArticleCapture);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setScope(itemId ? "item" : "pending");
		if (needsArticleCapture) setRefetch(true);
	}, [itemId, needsArticleCapture]);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: MouseEvent) {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		}
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const selectedStages = PROCESS_STAGE_OPTIONS.map((opt) => opt.id).filter(
		(id) => stages[id],
	);
	const canRun =
		(selectedStages.length > 0 || refetch || needsArticleCapture) && !running;

	function run() {
		if (!canRun) return;
		onRun({
			stages: selectedStages,
			force: scope !== "pending",
			itemIds: scope === "item" && itemId ? [itemId] : undefined,
			model,
			refetch: Boolean(refetch && (scope !== "item" || needsArticleCapture)),
		});
		setOpen(false);
	}

	return (
		<div
			className="relative"
			ref={rootRef}
			onClick={(event) => event.stopPropagation()}
		>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				disabled={running}
				className={
					compact
						? "rounded-md bg-violet-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-50"
						: "rounded-md bg-violet-500 px-3 py-2 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-50"
				}
			>
				{running ? "Processing…" : "Process"}
			</button>
			{open && (
				<div
					className={`absolute z-50 w-80 rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-2xl ${
						align === "up" ? "bottom-full mb-2" : "top-full mt-2"
					} ${menuSide === "right" ? "right-0" : "left-0"}`}
				>
					<p className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
						Run on
					</p>
					<div className="mt-2 grid gap-1">
						{itemId && (
							<label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900">
								<input
									type="radio"
									name={itemId ? `process-scope-${itemId}` : "process-scope"}
									checked={scope === "item"}
									onChange={() => setScope("item")}
									className="accent-violet-500"
								/>
								This item
							</label>
						)}
						<label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900">
							<input
								type="radio"
								name={itemId ? `process-scope-${itemId}` : "process-scope"}
								checked={scope === "pending"}
								onChange={() => setScope("pending")}
								className="accent-violet-500"
							/>
							Pending items
						</label>
						<label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-200 hover:bg-zinc-900">
							<input
								type="radio"
								name={itemId ? `process-scope-${itemId}` : "process-scope"}
								checked={scope === "all"}
								onChange={() => setScope("all")}
								className="accent-violet-500"
							/>
							All items
						</label>
					</div>

					<p className="mt-3 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
						Stages
					</p>
					<div className="mt-2 grid gap-1">
						{PROCESS_STAGE_OPTIONS.map((opt) => (
							<label
								key={opt.id}
								className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-900"
							>
								<input
									type="checkbox"
									checked={stages[opt.id]}
									onChange={(e) =>
										setStages((prev) => ({ ...prev, [opt.id]: e.target.checked }))
									}
									className="mt-0.5 accent-violet-500"
								/>
								<span>
									<span className="block text-sm text-zinc-200">{opt.label}</span>
									<span className="block text-xs text-zinc-500">{opt.hint}</span>
								</span>
							</label>
						))}
					</div>

					<p className="mt-3 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
						Model
					</p>
					<div className="mt-2 grid grid-cols-3 gap-1">
						{PROCESS_MODEL_OPTIONS.map((opt) => (
							<button
								key={opt.id}
								type="button"
								onClick={() => setModel(opt.id)}
								className={`rounded-md border px-2 py-1.5 text-xs ${
									model === opt.id
										? "border-violet-400 bg-violet-500/15 text-violet-200"
										: "border-zinc-800 text-zinc-400 hover:border-zinc-600"
								}`}
								title={opt.hint}
							>
								{opt.label}
							</button>
						))}
					</div>
					<p className="mt-1 text-[11px] text-zinc-600">
						Used for understanding and categorize.
					</p>

					{scope !== "item" || needsArticleCapture ? (
					<label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-900">
						<input
							type="checkbox"
							checked={refetch}
							onChange={(e) => setRefetch(e.target.checked)}
							className="mt-0.5 accent-violet-500"
						/>
						<span>
							<span className="block text-sm text-zinc-200">Refetch from X</span>
							<span className="block text-xs text-zinc-500">
								{needsArticleCapture
									? "Raw article body is still missing — capture it from X."
									: "Only articles whose stored raw is still a preview."}
							</span>
						</span>
					</label>
					) : (
						<p className="mt-3 text-xs text-zinc-600">
							Raw article body is already stored. Refetch from X is skipped.
						</p>
					)}

					<button
						type="button"
						onClick={run}
						disabled={!canRun}
						className="mt-3 w-full rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-40"
					>
						{refetch && selectedStages.length === 0
							? scope === "item"
								? "Refetch this item"
								: scope === "all"
									? "Refetch all articles"
									: "Refetch pending articles"
							: refetch
								? scope === "item"
									? "Process and refetch"
									: scope === "all"
										? "Re-run and refetch"
										: "Process pending and refetch"
								: scope === "item"
									? "Process this item"
									: scope === "all"
										? "Re-run selected stages"
										: "Process pending"}
					</button>
				</div>
			)}
		</div>
	);
}

function SettingsModal({
	prefs,
	uploading,
	onClose,
	onChange,
}: {
	prefs: ImportPrefs;
	uploading: boolean;
	onClose: () => void;
	onChange: (next: ImportPrefs) => void;
}) {
	return (
		<>
			<button
				type="button"
				aria-label="Close settings"
				onClick={onClose}
				className="fixed inset-0 z-40 bg-black/60"
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="settings-title"
				className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl"
			>
				<div className="flex items-start justify-between gap-3">
					<div>
						<p
							id="settings-title"
							className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase"
						>
							After import
						</p>
						<p className="mt-1 text-sm text-zinc-400">
							Remembered from last time. AI categorization is off unless you
							turn it on.
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
						aria-label="Close"
					>
						Esc
					</button>
				</div>
				<div className="mt-4 grid gap-2">
					<PrefToggle
						checked={prefs.entities}
						label="Extract entities"
						hint="Free. Handles, URLs, dates, post type."
						disabled={uploading}
						onChange={(entities) => onChange({ ...prefs, entities })}
					/>
					<PrefToggle
						checked={prefs.understanding}
						label="LLM understanding"
						hint="Cheap Haiku summary and tags."
						disabled={uploading}
						onChange={(understanding) => onChange({ ...prefs, understanding })}
					/>
					<PrefToggle
						checked={prefs.categorize}
						label="Categorize with AI"
						hint="Assign library categories. Run later if you prefer."
						disabled={uploading}
						onChange={(categorize) => onChange({ ...prefs, categorize })}
					/>
				</div>
			</div>
		</>
	);
}

function PrefToggle({
	checked,
	label,
	hint,
	disabled,
	onChange,
}: {
	checked: boolean;
	label: string;
	hint: string;
	disabled?: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-3 has-[:focus-visible]:border-zinc-500">
			<input
				type="checkbox"
				className="mt-1 size-4 accent-violet-500"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>
			<span>
				<span className="block text-sm text-zinc-200">{label}</span>
				<span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>
			</span>
		</label>
	);
}

function EmbeddedTweetList({
	embeds,
	className,
	compact = false,
}: {
	embeds: EmbeddedTweet[];
	className?: string;
	compact?: boolean;
}) {
	if (embeds.length === 0) return null;
	return (
		<div
			className={`space-y-2 ${className ?? ""}`}
			onClick={(e) => e.stopPropagation()}
		>
			{embeds.map((embed) => (
				<EmbeddedTweetCard key={`${embed.type}-${embed.id}`} embed={embed} compact={compact} />
			))}
		</div>
	);
}

function EmbeddedTweetCard({
	embed,
	compact = false,
}: {
	embed: EmbeddedTweet;
	compact?: boolean;
}) {
	return (
		<div
			className="overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/50"
			onClick={(e) => e.stopPropagation()}
		>
			<div className="border-b border-zinc-800/80 px-3 py-2">
				<div className="flex items-center gap-2">
					{embed.avatarUrl ? (
						<img
							src={embed.avatarUrl}
							alt=""
							className="size-5 shrink-0 rounded-full bg-zinc-800 object-cover"
						/>
					) : (
						<span className="size-5 shrink-0 rounded-full bg-zinc-800" />
					)}
					<div className="min-w-0">
						<p className="truncate text-xs font-medium text-zinc-200">
							{embed.name}
						</p>
						<p className="truncate font-mono text-[11px] text-zinc-500">
							@{embed.handle || "…"}
						</p>
					</div>
					<span className="ml-auto shrink-0 font-mono text-[10px] tracking-wide text-zinc-600 uppercase">
						{embed.type === "retweet" ? "Repost" : "Quote"}
					</span>
				</div>
			</div>
			<div className="px-3 py-2">
				{embed.text ? (
					<p
						className={`whitespace-pre-wrap text-zinc-300 ${
							compact ? "line-clamp-3 text-xs" : "text-sm leading-relaxed"
						}`}
					>
						{compact ? embed.text : <LinkifiedText text={embed.text} />}
					</p>
				) : null}
				{embed.mediaUrls[0] ? (
					<img
						src={embed.mediaUrls[0]}
						alt=""
						loading="lazy"
						className={`mt-2 w-full rounded-md border border-zinc-800 object-cover ${
							compact ? "max-h-20" : "max-h-40"
						}`}
					/>
				) : null}
				<a
					href={embed.url}
					target="_blank"
					rel="noreferrer"
					onClick={(e) => e.stopPropagation()}
					className="mt-2 inline-block text-xs text-zinc-500 hover:text-zinc-300"
				>
					View on X →
				</a>
			</div>
		</div>
	);
}

function ItemMedia({
	urls,
	className,
	compact = false,
}: {
	urls: string[];
	className?: string;
	compact?: boolean;
}) {
	if (urls.length === 0) return null;
	const shown = urls.slice(0, compact ? 2 : 4);
	return (
		<div
			className={`grid gap-1 ${shown.length > 1 ? "grid-cols-2" : "grid-cols-1"} ${className ?? ""}`}
			onClick={(e) => e.stopPropagation()}
		>
			{shown.map((url) => (
				<img
					key={url}
					src={url}
					alt=""
					loading="lazy"
					className={`w-full rounded-md border border-zinc-800 bg-zinc-900 object-cover ${
						compact ? "max-h-24" : "max-h-56"
					}`}
				/>
			))}
		</div>
	);
}

function ContentStat({
	label,
	bucket,
	showRaw = false,
}: {
	label: string;
	bucket: BucketStats;
	showRaw?: boolean;
}) {
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
			<div className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
				{label}
			</div>
			<div className="mt-1 text-xl font-medium">{bucket.total}</div>
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-zinc-500">
				{showRaw && (
					<span title="Captured GraphQL / article body. Never drop this.">
						R {bucket.raw.done}/{bucket.total}
					</span>
				)}
				<span>
					E {bucket.entities.done}/{bucket.total}
				</span>
				<span>
					U {bucket.understanding.done}/{bucket.total}
				</span>
				<span>
					C {bucket.categorized.done}/{bucket.total}
				</span>
			</div>
		</div>
	);
}

function TotalStat({
	items,
	archived,
}: {
	items: number;
	archived: number;
}) {
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
			<div className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
				Items
			</div>
			<div className="mt-1 text-xl font-medium">{items}</div>
			{archived > 0 && (
				<div className="mt-2 font-mono text-xs text-zinc-500">
					{archived} archived
				</div>
			)}
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
			<div className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
				{label}
			</div>
			<div className="mt-1 text-xl font-medium">{value}</div>
		</div>
	);
}

function SheetDateStatus({
	item,
	contentStatus,
	publishedDate,
}: {
	item: ClientItem;
	contentStatus: string | null;
	publishedDate: string | null;
}) {
	const stages = [
		{ short: "E", label: "Entities", done: Boolean(item.entities) },
		{ short: "U", label: "Understanding", done: Boolean(item.understanding) },
		{ short: "C", label: "Categories", done: Boolean(item.categorizedAt) },
	];
	const stageLabel = stages
		.map((stage) => `${stage.label} ${stage.done ? "complete" : "pending"}`)
		.join(", ");

	return (
		<div
			tabIndex={0}
			aria-label={`${contentStatus ? `${contentStatus}. ` : ""}${stageLabel}`}
			className="group relative ml-auto rounded-sm text-right outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
		>
			{publishedDate ? (
				<time
					dateTime={item.publishedAt ?? undefined}
					className="cursor-default font-mono text-xs text-zinc-500 decoration-zinc-700 underline-offset-4 group-hover:underline"
				>
					{publishedDate}
				</time>
			) : (
				<span className="cursor-default font-mono text-[11px] text-zinc-500">
					Status
				</span>
			)}
			<div
				role="tooltip"
				className="pointer-events-none absolute top-full right-0 z-20 mt-2 w-48 translate-y-1 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100 group-focus:translate-y-0 group-focus:opacity-100"
			>
				{contentStatus && (
					<div className="mb-1.5 border-b border-zinc-700 pb-2 text-left font-mono text-[11px] text-zinc-300">
						{contentStatus}
					</div>
				)}
				{stages.map((stage) => (
					<div
						key={stage.short}
						className="flex items-center gap-2 py-1 font-mono text-[11px]"
					>
						<span
							className={
								stage.done ? "text-emerald-400" : "text-zinc-600"
							}
						>
							{stage.short}
						</span>
						<span className="text-zinc-300">{stage.label}</span>
						<span className="ml-auto text-zinc-500">
							{stage.done ? "Done" : "Pending"}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

function parseJson<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<]+[^\s<.,;:"')\]}!?]/gi;

function LinkifiedText({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const parts: ReactNode[] = [];
	let last = 0;
	const urlPattern = new RegExp(URL_IN_TEXT_RE.source, URL_IN_TEXT_RE.flags);
	for (const match of text.matchAll(urlPattern)) {
		const start = match.index ?? 0;
		if (start > last) parts.push(text.slice(last, start));
		const url = match[0];
		parts.push(
			<a
				key={start}
				href={url}
				target="_blank"
				rel="noreferrer"
				onClick={(e) => e.stopPropagation()}
				className="text-violet-300 underline decoration-violet-300/40 hover:text-violet-200"
			>
				{url}
			</a>,
		);
		last = start + url.length;
	}
	if (last < text.length) parts.push(text.slice(last));
	if (parts.length === 0) {
		return <span className={className}>{text}</span>;
	}
	return <span className={className}>{parts}</span>;
}

function ItemSheet({
	item,
	index,
	total,
	prefs,
	processing,
	onClose,
	onPrev,
	onNext,
	onDelete,
	onProcess,
}: {
	item: ClientItem;
	index: number;
	total: number;
	prefs: ImportPrefs;
	processing: boolean;
	onClose: () => void;
	onPrev: () => void;
	onNext: () => void;
	onDelete: () => void;
	onProcess: (opts: ProcessRunOptions) => void;
}) {
	const understanding = parseJson<{
		summary?: string;
		tags?: string[];
		sentiment?: string;
		people?: string[];
		companies?: string[];
	}>(item.understanding);
	const entities = parseJson<{
		hashtags?: string[];
		urls?: string[];
		mentions?: string[];
		tools?: string[];
		tweetType?: string;
		hasMedia?: boolean;
		mediaTypes?: string[];
	}>(item.entities);
	const publishedDate = item.publishedAt
		? new Date(item.publishedAt).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			})
		: null;
	const postUrl = itemUrl(item);
	const isArticle = item.contentType === "article";
	const article = isArticle ? articleDisplay(item) : null;
	const footerLabel = isArticle ? "Open article on X" : "Open on X";
	const contentStatus = item.articleRefetching
		? "Refetch queued"
		: isArticle && !item.articleHydrated
			? "Full text pending"
			: null;

	return (
		<>
			<button
				type="button"
				aria-label="Close details"
				onClick={onClose}
				className="fixed inset-0 z-40 bg-black/40"
			/>
			<aside
				role="dialog"
				aria-modal="true"
				aria-labelledby="item-sheet-title"
				className="fixed inset-3 z-50 flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl ring-1 ring-white/5 sm:inset-y-4 sm:right-4 sm:left-auto sm:w-[min(100vw-2rem,48rem)]"
			>
				<header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
					<p
						id="item-sheet-title"
						className="font-mono text-xs tracking-wide text-zinc-500 uppercase"
					>
						{index + 1} / {total}
					</p>
					<ProcessMenu
						prefs={prefs}
						itemId={item.id}
						running={processing}
						compact
						needsArticleCapture={
							item.contentType === "article" && item.articleHydrated !== true
						}
						onRun={onProcess}
					/>
					<div className="ml-auto flex items-center gap-1">
						<button
							type="button"
							onClick={onPrev}
							disabled={index <= 0}
							className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
							aria-label="Previous"
						>
							↑
						</button>
						<button
							type="button"
							onClick={onNext}
							disabled={index >= total - 1}
							className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-30"
							aria-label="Next"
						>
							↓
						</button>
						<button
							type="button"
							onClick={onClose}
							className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
							aria-label="Close"
						>
							Esc
						</button>
					</div>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
					<div className="flex items-start gap-4">
						<Author item={item} linkProfile />
						<SheetDateStatus
							item={item}
							contentStatus={contentStatus}
							publishedDate={publishedDate}
						/>
					</div>
					{article ? (
						<div className="mt-5">
							<div className="flex items-start justify-between gap-4">
								<h2 className="min-w-0 flex-1 text-lg font-medium tracking-tight text-zinc-100">
									{article.title || "(untitled)"}
								</h2>
								<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
									<TypeBadges item={item} />
								</div>
							</div>
							<ArticleBody
								content={item.articleContent}
								fallbackText={article.rest}
							/>
						</div>
					) : (
						<div className="mt-5 flex items-start justify-between gap-4">
							<p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
								{item.text ? (
									<LinkifiedText text={item.text} />
								) : (
									"(empty)"
								)}
							</p>
							<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
								<TypeBadges item={item} />
							</div>
						</div>
					)}
					{(item.embeds?.length ?? 0) > 0 && (
						<EmbeddedTweetList embeds={item.embeds ?? []} className="mt-4" />
					)}
					{!articleContentHasInlineMedia(item.articleContent) && (
						<ItemMedia urls={item.mediaUrls} className="mt-4" />
					)}

					{item.categories.length > 0 && (
						<div className="mt-4 flex flex-wrap gap-1">
							<CategoryBadges item={item} />
						</div>
					)}

					{understanding && (
						<SheetSection title="Understanding">
							{understanding.summary && (
								<p className="text-sm text-zinc-300">
									<LinkifiedText text={understanding.summary} />
								</p>
							)}
							{understanding.sentiment && (
								<p className="mt-2 font-mono text-xs text-zinc-500">
									Sentiment · {understanding.sentiment}
								</p>
							)}
							<ChipList values={understanding.tags} />
							<ChipList values={understanding.people} />
							<ChipList values={understanding.companies} />
						</SheetSection>
					)}

					{entities && (
						<SheetSection title="Entities">
							{entities.tweetType && (
								<p className="font-mono text-xs text-zinc-500">
									{entities.tweetType}
								</p>
							)}
							<ChipList
								values={entities.hashtags?.map(
									(h) => `#${h.replace(/^#/, "")}`,
								)}
							/>
							<ChipList
								values={entities.mentions?.map(
									(m) => `@${m.replace(/^@/, "")}`,
								)}
								links={entities.mentions?.map((m) =>
									item.source === "x"
										? `https://x.com/${m.replace(/^@/, "")}`
										: undefined,
								)}
							/>
							<ChipList values={entities.tools} />
							{entities.urls?.map((url) => (
								<a
									key={url}
									href={url}
									target="_blank"
									rel="noreferrer"
									className="mt-1 block truncate text-xs text-violet-300 hover:text-violet-200"
								>
									{url}
								</a>
							))}
						</SheetSection>
					)}
				</div>

				<footer className="flex items-center gap-3 border-t border-zinc-800 px-4 py-3">
					{postUrl && (
						<a
							href={postUrl}
							target="_blank"
							rel="noreferrer"
							className="text-sm text-violet-300 underline decoration-violet-300/40 hover:text-violet-200"
						>
							{footerLabel}
						</a>
					)}
					<button
						type="button"
						onClick={onDelete}
						className="text-sm text-zinc-500 hover:text-red-400"
					>
						Delete
					</button>
					<p className="ml-auto font-mono text-[11px] text-zinc-600">
						j/k · ↑/↓ · esc
					</p>
				</footer>
			</aside>
		</>
	);
}

function SheetSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="mt-6 border-t border-zinc-800 pt-4">
			<h2 className="mb-2 font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
				{title}
			</h2>
			{children}
		</section>
	);
}

function ChipList({
	values,
	links,
}: {
	values?: string[];
	links?: (string | undefined)[];
}) {
	if (!values?.length) return null;
	return (
		<div className="mt-2 flex flex-wrap gap-1">
			{values.map((value, i) => {
				const href = links?.[i];
				const className =
					"rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300";
				if (href) {
					return (
						<a
							key={value}
							href={href}
							target="_blank"
							rel="noreferrer"
							className={`${className} hover:bg-zinc-700 hover:text-white`}
						>
							{value}
						</a>
					);
				}
				return (
					<span key={value} className={className}>
						{value}
					</span>
				);
			})}
		</div>
	);
}
