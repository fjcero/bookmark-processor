"use client";

import { useMemo, useState } from "react";
import type { ActivityMetric, ActivitySeries } from "@/lib/activity-types";
import { maxActivityCount } from "@/lib/activity-types";

const METRICS: { id: ActivityMetric; label: string; title: string }[] = [
	{
		id: "published",
		label: "Original date",
		title: "When the post or article was published",
	},
	{
		id: "bookmarked",
		label: "Bookmarked at",
		title: "When it was saved into this library",
	},
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function parseDay(date: string): Date {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y, m - 1, d);
}

function level(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
	if (count <= 0 || max <= 0) return 0;
	const ratio = count / max;
	if (ratio >= 0.75) return 4;
	if (ratio >= 0.5) return 3;
	if (ratio >= 0.25) return 2;
	return 1;
}

const LEVEL_CLASS: Record<0 | 1 | 2 | 3 | 4, string> = {
	0: "bg-zinc-800/80",
	1: "bg-emerald-950",
	2: "bg-emerald-800/80",
	3: "bg-emerald-600/90",
	4: "bg-emerald-400",
};

export default function ActivityHeatmap({
	series,
}: {
	series: ActivitySeries;
}) {
	const [metric, setMetric] = useState<ActivityMetric>("published");
	const days = series[metric];
	const max = maxActivityCount(days);
	const countByDate = useMemo(
		() => new Map(days.map((d) => [d.date, d.count])),
		[days],
	);

	const grid = useMemo(() => {
		if (days.length === 0) {
			return {
				weeks: [] as { date: Date; count: number }[][],
				monthSpans: [] as { label: string; cols: number }[],
			};
		}

		const first = parseDay(days[0].date);
		const last = parseDay(days[days.length - 1].date);
		const start = new Date(first);
		start.setDate(start.getDate() - start.getDay());

		const totalDays =
			Math.ceil((last.getTime() - start.getTime()) / 86_400_000) + 1;
		const weekCount = Math.ceil(totalDays / 7);
		const weeks: { date: Date; count: number }[][] = [];

		for (let wi = 0; wi < weekCount; wi++) {
			const week: { date: Date; count: number }[] = [];
			for (let di = 0; di < 7; di++) {
				const date = new Date(start);
				date.setDate(start.getDate() + wi * 7 + di);
				const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
				week.push({ date, count: countByDate.get(key) ?? 0 });
			}
			weeks.push(week);
		}

		const monthSpans: { label: string; cols: number }[] = [];
		let i = 0;
		while (i < weeks.length) {
			const month = weeks[i][0].date.getMonth();
			let cols = 0;
			while (
				i + cols < weeks.length &&
				weeks[i + cols][0].date.getMonth() === month
			)
				cols++;
			monthSpans.push({ label: MONTH_LABELS[month], cols });
			i += cols;
		}

		return { weeks, monthSpans };
	}, [days, countByDate]);

	return (
		<section className="mb-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-sm font-medium text-zinc-200">Activity</h2>
				<div className="flex rounded-lg border border-zinc-700 bg-zinc-950/60 p-0.5">
					{METRICS.map((m) => (
						<button
							key={m.id}
							type="button"
							title={m.title}
							onClick={() => setMetric(m.id)}
							className={`rounded-md px-3 py-1 text-xs transition ${
								metric === m.id
									? "bg-zinc-800 text-zinc-100"
									: "text-zinc-500 hover:text-zinc-300"
							}`}
						>
							{m.label}
						</button>
					))}
				</div>
			</div>

			<div className="overflow-x-auto">
				<div className="min-w-[640px]">
					<div className="mb-1 flex pl-8 text-[10px] text-zinc-500">
						{grid.monthSpans.map((span) => (
							<div
								key={`${span.label}-${span.cols}`}
								style={{ width: span.cols * 14 }}
								className="shrink-0"
							>
								{span.label}
							</div>
						))}
					</div>
					<div className="flex gap-1">
						<div className="flex w-7 shrink-0 flex-col justify-between py-[2px] text-[10px] leading-none text-zinc-600">
							{WEEKDAY_LABELS.map((label, i) => (
								<span
									key={label}
									className={
										i % 2 === 0 ? "opacity-100" : "opacity-0 sm:opacity-100"
									}
								>
									{label}
								</span>
							))}
						</div>
						<div className="flex gap-[3px]">
							{grid.weeks.map((week) => (
								<div
									key={week[0].date.toISOString()}
									className="flex flex-col gap-[3px]"
								>
									{week.map((cell) => {
										const lv = level(cell.count, max);
										const title = `${cell.date.toLocaleDateString(undefined, { dateStyle: "medium" })}: ${cell.count}`;
										return (
											<div
												key={cell.date.toISOString()}
												title={title}
												className={`h-[11px] w-[11px] rounded-[2px] ${LEVEL_CLASS[lv]}`}
											/>
										);
									})}
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
