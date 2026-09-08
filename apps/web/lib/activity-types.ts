export type ActivityMetric = "published" | "bookmarked";

export interface ActivityDay {
	date: string;
	count: number;
}

export interface ActivitySeries {
	published: ActivityDay[];
	bookmarked: ActivityDay[];
}

export function maxActivityCount(series: ActivityDay[]): number {
	return series.reduce((max, day) => Math.max(max, day.count), 0);
}
