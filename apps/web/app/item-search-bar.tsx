"use client";

import type { ContentType, PostFormat } from "@repo/import";
import type { ItemSort, ViewMode } from "@/lib/import-prefs";

export interface ItemSearchState {
	q: string;
	contentType?: ContentType;
	postFormat?: PostFormat;
}

const CONTENT_FILTERS: Array<{
	id: ContentType | "all";
	label: string;
}> = [
	{ id: "all", label: "All" },
	{ id: "post", label: "Posts" },
	{ id: "article", label: "Articles" },
];

const FORMAT_FILTERS: Array<{
	id: PostFormat;
	label: string;
}> = [
	{ id: "reply", label: "Reply" },
	{ id: "quote", label: "Quote" },
	{ id: "repost", label: "Repost" },
	{ id: "thread", label: "Thread" },
];

const SORT_FILTERS: Array<{ id: ItemSort; label: string }> = [
	{ id: "saved", label: "Saved" },
	{ id: "published", label: "Published" },
	{ id: "imported", label: "Imported" },
];

export default function ItemSearchBar({
	value,
	onChange,
	view,
	onViewChange,
	sort,
	onSortChange,
	resultCount,
	loading,
}: {
	value: ItemSearchState;
	onChange: (next: ItemSearchState) => void;
	view: ViewMode;
	onViewChange: (view: ViewMode) => void;
	sort: ItemSort;
	onSortChange: (sort: ItemSort) => void;
	resultCount: number | null;
	loading?: boolean;
}) {
	const active =
		value.q.trim().length > 0 || value.contentType || value.postFormat;

	return (
		<section className="mb-6 space-y-3">
			<div className="relative">
				<span
					className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-500"
					aria-hidden
				>
					⌕
				</span>
				<input
					type="search"
					value={value.q}
					onChange={(e) => onChange({ ...value, q: e.target.value })}
					placeholder="Search title, author, content, type…"
					className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 py-2.5 pr-10 pl-9 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/60 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
					aria-label="Search bookmarks"
				/>
				{active && (
					<button
						type="button"
						onClick={() => onChange({ q: "" })}
						className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
						aria-label="Clear search"
					>
						Clear
					</button>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="flex rounded-lg border border-zinc-700 bg-zinc-950/60 p-0.5">
					{CONTENT_FILTERS.map((filter) => {
						const selected =
							filter.id === "all"
								? !value.contentType
								: value.contentType === filter.id;
						return (
							<button
								key={filter.id}
								type="button"
								onClick={() =>
									onChange({
										...value,
										contentType:
											filter.id === "all"
												? undefined
												: filter.id,
										postFormat:
											filter.id === "article"
												? undefined
												: value.postFormat,
									})
								}
								className={`rounded-md px-3 py-1 text-xs transition ${
									selected
										? "bg-zinc-800 text-zinc-100"
										: "text-zinc-500 hover:text-zinc-300"
								}`}
							>
								{filter.label}
							</button>
						);
					})}
				</div>

				<span className="text-zinc-700">·</span>

				<div className="flex flex-wrap gap-1.5">
					{FORMAT_FILTERS.map((filter) => {
						const selected = value.postFormat === filter.id;
						return (
							<button
								key={filter.id}
								type="button"
								disabled={value.contentType === "article"}
								onClick={() =>
									onChange({
										...value,
										postFormat: selected ? undefined : filter.id,
									})
								}
								className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase transition ${
									selected
										? "border-violet-500/50 bg-violet-500/15 text-violet-200"
										: "border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
								}`}
							>
								{filter.label}
							</button>
						);
					})}
				</div>

				<span className="text-zinc-700">·</span>

				<div
					className="flex rounded-lg border border-zinc-700 bg-zinc-950/60 p-0.5"
					role="group"
					aria-label="Sort"
				>
					{SORT_FILTERS.map((filter) => (
						<button
							key={filter.id}
							type="button"
							onClick={() => onSortChange(filter.id)}
							aria-pressed={sort === filter.id}
							className={`rounded-md px-3 py-1 text-xs font-medium transition ${
								sort === filter.id
									? "bg-zinc-800 text-zinc-100"
									: "text-zinc-500 hover:text-zinc-300"
							}`}
						>
							{filter.label}
						</button>
					))}
				</div>

				<div className="flex rounded-lg border border-zinc-700 bg-zinc-950/60 p-0.5">
					<button
						type="button"
						onClick={() => onViewChange("list")}
						className={`rounded-md px-3 py-1 text-xs font-medium transition ${
							view === "list"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
					>
						List
					</button>
					<button
						type="button"
						onClick={() => onViewChange("grid")}
						className={`rounded-md px-3 py-1 text-xs font-medium transition ${
							view === "grid"
								? "bg-zinc-800 text-zinc-100"
								: "text-zinc-500 hover:text-zinc-300"
						}`}
					>
						Grid
					</button>
				</div>

				{(resultCount !== null || loading) && (
					<p className="ml-auto font-mono text-[11px] text-zinc-500">
						{loading ? "Searching…" : `${resultCount ?? 0} results`}
					</p>
				)}
			</div>
		</section>
	);
}
