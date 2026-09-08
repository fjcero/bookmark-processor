import { and, count, eq, gt, inArray, isNull } from "drizzle-orm";
import { isPendingArticleRaw } from "@repo/import";
import { db, itemCategories, itemRaw, items } from "@repo/db";
import { extractEntities, type ExtractedEntities } from "./entities";
import {
	categorizeBatch,
	CATEGORIZE_BATCH_SIZE,
	mapItemForCategorization,
	seedDefaultCategories,
	writeCategoryResults,
} from "./categorizer";
import {
	EMPTY_UNDERSTANDING,
	UNDERSTANDING_BATCH_SIZE,
	understandBatch,
	type ItemForUnderstanding,
} from "./understanding";
import { setActiveModel, type ProcessModelId } from "./llm";

export type Stage = "entities" | "understanding" | "categorize";

let processItemIds: string[] | null = null;

function scopeAnd(
	...extra: Array<ReturnType<typeof and> | undefined>
) {
	return and(
		isNull(items.archivedAt),
		processItemIds && processItemIds.length > 0
			? inArray(items.id, processItemIds)
			: undefined,
		...extra,
	);
}

export interface ProcessState {
	status: "idle" | "running" | "stopping";
	stage: Stage | null;
	done: number;
	total: number;
	stageCounts: {
		entities: number;
		understanding: number;
		categorized: number;
	};
	lastError: string | null;
	error: string | null;
}

const globalState = globalThis as unknown as {
	processState: ProcessState;
	processAbort: boolean;
	processRunning: boolean;
};

if (!globalState.processState) {
	globalState.processState = {
		status: "idle",
		stage: null,
		done: 0,
		total: 0,
		stageCounts: { entities: 0, understanding: 0, categorized: 0 },
		lastError: null,
		error: null,
	};
}
if (globalState.processAbort === undefined) globalState.processAbort = false;
if (globalState.processRunning === undefined)
	globalState.processRunning = false;

export function getProcessState(): ProcessState {
	return { ...globalState.processState };
}

function setState(update: Partial<ProcessState>): void {
	globalState.processState = { ...globalState.processState, ...update };
}

function shouldAbort(): boolean {
	return globalState.processAbort;
}

export function requestStop(): void {
	globalState.processAbort = true;
	setState({ status: "stopping" });
}

function isUnhydratedArticle(contentType: string | null, rawJson: string): boolean {
	return isPendingArticleRaw(rawJson, contentType ?? undefined);
}

function pendingWhere(
	field:
		| typeof items.entities
		| typeof items.understanding
		| typeof items.categorizedAt,
	cursor?: string,
) {
	return scopeAnd(isNull(field), cursor ? gt(items.id, cursor) : undefined);
}

async function runEntities(
	onProgress: (done: number) => void,
): Promise<number> {
	const CHUNK = 100;
	let processed = 0;
	let cursor: string | undefined;

	while (true) {
		if (shouldAbort()) break;
		const rows = await db
			.select({
				id: items.id,
				rawJson: itemRaw.payload,
			})
			.from(items)
			.leftJoin(
				itemRaw,
				and(
					eq(itemRaw.source, items.source),
					eq(itemRaw.externalId, items.externalId),
				),
			)
			.where(pendingWhere(items.entities, cursor))
			.orderBy(items.id)
			.limit(CHUNK);

		if (rows.length === 0) break;
		cursor = rows[rows.length - 1].id;

		for (const row of rows) {
			const entities = extractEntities(row.rawJson ?? "");
			await db
				.update(items)
				.set({ entities: JSON.stringify(entities) })
				.where(eq(items.id, row.id));
			processed++;
			onProgress(processed);
		}

		if (rows.length < CHUNK) break;
	}

	return processed;
}

async function runUnderstanding(
	onProgress: (done: number) => void,
): Promise<number> {
	let processed = 0;
	let cursor: string | undefined;

	while (true) {
		if (shouldAbort()) break;
		const rows = await db
			.select({
				id: items.id,
				externalId: items.externalId,
				text: items.text,
				contentType: items.contentType,
				entities: items.entities,
				rawJson: itemRaw.payload,
			})
			.from(items)
			.leftJoin(
				itemRaw,
				and(
					eq(itemRaw.source, items.source),
					eq(itemRaw.externalId, items.externalId),
				),
			)
			.where(pendingWhere(items.understanding, cursor))
			.orderBy(items.id)
			.limit(UNDERSTANDING_BATCH_SIZE);

		if (rows.length === 0) break;
		cursor = rows[rows.length - 1].id;

		const ready = rows.filter(
			(r) => !isUnhydratedArticle(r.contentType, r.rawJson ?? ""),
		);
		const trivial = ready.filter(
			(r) => r.contentType !== "article" && r.text.trim().length < 20,
		);
		const toEnrich = ready.filter(
			(r) => r.contentType === "article" || r.text.trim().length >= 20,
		);

		for (const row of trivial) {
			await db
				.update(items)
				.set({ understanding: JSON.stringify(EMPTY_UNDERSTANDING) })
				.where(eq(items.id, row.id));
			processed++;
		}

		if (toEnrich.length > 0) {
			const batch: ItemForUnderstanding[] = toEnrich.map((row) => {
				let entities: ExtractedEntities | null = null;
				if (row.entities) {
					try {
						entities = JSON.parse(row.entities) as ExtractedEntities;
					} catch {
						entities = null;
					}
				}
				return {
					externalId: row.externalId,
					text: row.text,
					contentType: row.contentType,
					entities,
				};
			});

			try {
				const results = await understandBatch(batch);
				const byExternalId = new Map(
					results.map((r) => [r.externalId, r.understanding]),
				);
				for (const row of toEnrich) {
					const understanding =
						byExternalId.get(row.externalId) ?? EMPTY_UNDERSTANDING;
					await db
						.update(items)
						.set({ understanding: JSON.stringify(understanding) })
						.where(eq(items.id, row.id));
					processed++;
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error("[understanding] batch failed:", msg);
				setState({ lastError: msg });
			}
		}

		onProgress(processed);
		if (rows.length < UNDERSTANDING_BATCH_SIZE) break;
	}

	return processed;
}

async function runCategorize(
	onProgress: (done: number) => void,
): Promise<number> {
	await seedDefaultCategories();
	let processed = 0;
	let cursor: string | undefined;

	while (true) {
		if (shouldAbort()) break;
		const rows = await db
			.select({
				id: items.id,
				externalId: items.externalId,
				text: items.text,
				entities: items.entities,
				understanding: items.understanding,
				contentType: items.contentType,
				rawJson: itemRaw.payload,
			})
			.from(items)
			.leftJoin(
				itemRaw,
				and(
					eq(itemRaw.source, items.source),
					eq(itemRaw.externalId, items.externalId),
				),
			)
			.where(pendingWhere(items.categorizedAt, cursor))
			.orderBy(items.id)
			.limit(CATEGORIZE_BATCH_SIZE);

		if (rows.length === 0) break;
		cursor = rows[rows.length - 1].id;

		const ready = rows.filter(
			(r) => !isUnhydratedArticle(r.contentType, r.rawJson ?? ""),
		);
		if (ready.length === 0) {
			if (rows.length < CATEGORIZE_BATCH_SIZE) break;
			continue;
		}

		try {
			const batch = ready.map(mapItemForCategorization);
			const results = await categorizeBatch(batch);
			await writeCategoryResults(results);
			const categorizedIds = new Set(
				results
					.filter((r) => r.assignments.length > 0)
					.map((r) => r.externalId),
			);
			for (const row of ready) {
				if (!categorizedIds.has(row.externalId)) {
					await db
						.update(items)
						.set({ categorizedAt: new Date() })
						.where(eq(items.id, row.id));
				}
			}
			processed += ready.length;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("[categorize] batch failed:", msg);
			setState({ lastError: msg });
		}

		onProgress(processed);
		if (rows.length < CATEGORIZE_BATCH_SIZE) break;
	}

	return processed;
}

export interface ProcessOptions {
	force?: boolean;
	stages?: Stage[];
	itemIds?: string[];
	model?: ProcessModelId | string;
}

export async function startProcess(
	options: ProcessOptions = {},
): Promise<void> {
	const force = Boolean(options.force);
	processItemIds =
		options.itemIds && options.itemIds.length > 0 ? options.itemIds : null;
	if (options.model) setActiveModel(options.model);
	const enabled = new Set<Stage>(
		options.stages !== undefined
			? options.stages
			: ["entities", "understanding", "categorize"],
	);

	if (globalState.processRunning) {
		throw new Error("Processing is already running");
	}

	globalState.processRunning = true;
	globalState.processAbort = false;
	setState({
		status: "running",
		stage: null,
		done: 0,
		total: 0,
		stageCounts: { entities: 0, understanding: 0, categorized: 0 },
		lastError: null,
		error: null,
	});

	try {
		if (force) {
			const reset: {
				entities?: null;
				understanding?: null;
				categorizedAt?: null;
			} = {};
			if (enabled.has("entities")) reset.entities = null;
			if (enabled.has("understanding")) reset.understanding = null;
			if (enabled.has("categorize")) reset.categorizedAt = null;
			if (Object.keys(reset).length > 0) {
				await db.update(items).set(reset).where(scopeAnd());
			}
			if (enabled.has("categorize")) {
				await db
					.delete(itemCategories)
					.where(
						inArray(
							itemCategories.itemId,
							db.select({ id: items.id }).from(items).where(scopeAnd()),
						),
					);
			}
		}

		const [entitiesPending] = enabled.has("entities")
			? await db
					.select({ n: count() })
					.from(items)
					.where(and(scopeAnd(), isNull(items.entities)))
			: [{ n: 0 }];
		const [understandingPending] = enabled.has("understanding")
			? await db
					.select({ n: count() })
					.from(items)
					.where(and(scopeAnd(), isNull(items.understanding)))
			: [{ n: 0 }];
		const [categorizePending] = enabled.has("categorize")
			? await db
					.select({ n: count() })
					.from(items)
					.where(and(scopeAnd(), isNull(items.categorizedAt)))
			: [{ n: 0 }];

		const total =
			entitiesPending.n + understandingPending.n + categorizePending.n;
		setState({ total });

		let done = 0;

		if (enabled.has("entities") && !shouldAbort()) {
			setState({ stage: "entities", done });
			const entitiesCount = await runEntities((n) => {
				setState({
					done: done + n,
					stageCounts: { ...globalState.processState.stageCounts, entities: n },
				});
			});
			done += entitiesCount;
			setState({
				done,
				stageCounts: {
					...globalState.processState.stageCounts,
					entities: entitiesCount,
				},
			});
		}

		if (enabled.has("understanding") && !shouldAbort()) {
			setState({ stage: "understanding" });
			const understandingCount = await runUnderstanding((n) => {
				setState({
					done: done + n,
					stageCounts: {
						...globalState.processState.stageCounts,
						understanding: n,
					},
				});
			});
			done += understandingCount;
			setState({
				done,
				stageCounts: {
					...globalState.processState.stageCounts,
					understanding: understandingCount,
				},
			});
		}

		if (enabled.has("categorize") && !shouldAbort()) {
			setState({ stage: "categorize" });
			const categorizedCount = await runCategorize((n) => {
				setState({
					done: done + n,
					stageCounts: {
						...globalState.processState.stageCounts,
						categorized: n,
					},
				});
			});
			done += categorizedCount;
			setState({
				done,
				stageCounts: {
					...globalState.processState.stageCounts,
					categorized: categorizedCount,
				},
			});
		}

		setState({ status: "idle", stage: null, done: total });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		setState({ status: "idle", error: msg, lastError: msg });
	} finally {
		globalState.processRunning = false;
		globalState.processAbort = false;
		processItemIds = null;
	}
}
