import { and, eq, inArray, isNull } from "drizzle-orm";
import { categories, db, itemCategories, items } from "@repo/db";
import { completePrompt, extractJsonArray } from "./llm";
import { createId } from "./ids";

const BATCH_SIZE = 20;

export const DEFAULT_CATEGORIES = [
	{
		name: "AI & Machine Learning",
		slug: "ai-resources",
		color: "#8b5cf6",
		description:
			"Artificial intelligence, machine learning, LLMs, ChatGPT, Claude, Gemini, Grok, Midjourney, Sora, AI agents, RAG, fine-tuning, prompts, vector databases, model benchmarks, AI startups, AI safety, multimodal models",
	},
	{
		name: "Crypto & Web3",
		slug: "finance-crypto",
		color: "#f59e0b",
		description:
			"Cryptocurrency, Bitcoin, Ethereum, Solana, DeFi protocols, NFTs, on-chain activity, crypto trading, altcoins, airdrops, memecoin, Web3 development, smart contracts, DAOs, Layer 2, Uniswap, pump.fun, wallets, blockchain analytics",
	},
	{
		name: "Dev Tools & Engineering",
		slug: "dev-tools",
		color: "#06b6d4",
		description:
			"Software engineering, coding, GitHub, open source, frameworks, APIs, databases, DevOps, CI/CD, terminal tools, debugging, system design, backend, frontend, mobile dev, Rust, Go, TypeScript, Python, Vercel, Supabase, Docker",
	},
	{
		name: "Finance & Investing",
		slug: "finance-investing",
		color: "#10b981",
		description:
			"Stock market, equities, options trading, macroeconomics, Federal Reserve, interest rates, hedge funds, venture capital, private equity, earnings reports, portfolio management, real estate investing, commodities, forex, financial charts — NOT crypto",
	},
	{
		name: "Startups & Business",
		slug: "startups-business",
		color: "#f97316",
		description:
			"Startups, founders, entrepreneurship, SaaS, product-market fit, fundraising, VC, angel investing, growth hacking, B2B, marketing, sales, revenue, bootstrapping, Y Combinator, acquisition, company building, business strategy",
	},
	{
		name: "News & Politics",
		slug: "news",
		color: "#6366f1",
		description:
			"Breaking news, current events, US politics, global politics, geopolitics, government policy, elections, regulation, tech policy, AI regulation, crypto regulation, war and conflict, international relations, journalism, investigative reporting",
	},
	{
		name: "Design & Product",
		slug: "design",
		color: "#ec4899",
		description:
			"UI/UX design, product design, visual design, Figma, typography, design systems, motion design, brand identity, user research, product strategy, wireframes, creative tools, color theory, web design, app design",
	},
	{
		name: "Health & Wellness",
		slug: "health-wellness",
		color: "#14b8a6",
		description:
			"Fitness, nutrition, longevity, biohacking, sleep, mental health, supplements, workout routines, diet, weight loss, strength training, cognitive performance, stress management, meditation, gut health, lab results, wearables like Whoop and Oura",
	},
	{
		name: "Security & Privacy",
		slug: "security-privacy",
		color: "#ef4444",
		description:
			"Cybersecurity, hacking, exploits, vulnerabilities, OPSEC, privacy tools, VPNs, encryption, threat intelligence, social engineering, phishing, malware, zero-days, pen testing, CTF, data breaches, authentication, identity security",
	},
	{
		name: "Science & Research",
		slug: "science-research",
		color: "#3b82f6",
		description:
			"Scientific research, papers, discoveries, physics, biology, neuroscience, space exploration, climate, chemistry, medical breakthroughs, academic studies, emerging technology, robotics, quantum computing, energy, materials science",
	},
	{
		name: "Productivity",
		slug: "productivity",
		color: "#a855f7",
		description:
			"Productivity systems, time management, habits, focus techniques, note-taking, second brain, deep work, mental models, PKM tools like Obsidian and Notion, life optimization, workflows, automation, delegation",
	},
	{
		name: "Funny & Memes",
		slug: "funny-memes",
		color: "#eab308",
		description:
			"Memes, jokes, satire, humor, viral content, relatable posts, shitposts, funny screenshots, comedy threads, parody, ironic takes — content whose primary purpose is to be funny or entertaining",
	},
	{
		name: "General",
		slug: "general",
		color: "#64748b",
		description:
			"Miscellaneous content that doesn't clearly fit any other category — use sparingly, only when no other category applies",
	},
] as const;

interface ItemForCategorization {
	externalId: string;
	text: string;
	tags?: string[];
	hashtags?: string[];
	tools?: string[];
}

interface CategoryAssignment {
	category: string;
	confidence: number;
}

interface CategorizationResult {
	externalId: string;
	assignments: CategoryAssignment[];
}

export async function seedDefaultCategories(): Promise<void> {
	const existing = await db
		.select({ slug: categories.slug, id: categories.id })
		.from(categories);
	const bySlug = new Map(existing.map((c) => [c.slug, c.id]));

	for (const cat of DEFAULT_CATEGORIES) {
		const id = bySlug.get(cat.slug);
		if (id) {
			await db
				.update(categories)
				.set({ name: cat.name, color: cat.color, description: cat.description })
				.where(eq(categories.id, id));
		} else {
			await db.insert(categories).values({
				id: createId(),
				slug: cat.slug,
				name: cat.name,
				color: cat.color,
				description: cat.description,
			});
		}
	}
}

function buildCategorizationPrompt(
	bookmarks: ItemForCategorization[],
	categoryDescriptions: Record<string, string>,
	allSlugs: string[],
): string {
	const categoriesList = allSlugs
		.map(
			(slug) =>
				`- ${slug}: ${categoryDescriptions[slug] ?? slug.replace(/-/g, " ")}`,
		)
		.join("\n");

	const itemData = bookmarks.map((b) => {
		const entry: Record<string, unknown> = {
			externalId: b.externalId,
			text: b.text.slice(0, 400),
		};
		if (b.tags?.length) entry.aiTags = b.tags.slice(0, 15).join(", ");
		if (b.hashtags?.length) entry.hashtags = b.hashtags.slice(0, 10).join(", ");
		if (b.tools?.length) entry.tools = b.tools.join(", ");
		return entry;
	});

	return `You are an expert librarian categorizing saved items into a personal knowledge base. Your categorizations directly power search and discovery — accuracy is critical.

AVAILABLE CATEGORIES:
${categoriesList}

CATEGORIZATION RULES:
- Assign 1-3 categories per item — only what CLEARLY applies
- Confidence 0.5-1.0: use 0.9+ for obvious fits, 0.6-0.8 for plausible, 0.5 for borderline
- Priority: specific categories beat "general" — only use "general" when truly nothing else fits
- Use ALL signals: text, hashtags, detected tools, semantic AI tags

AVOID:
- Over-assigning "general" — it's a catch-all, not a default
- Conflating news about AI with AI resources (a news thread about OpenAI is "news", not "ai-resources")
- Assigning categories based only on passing mentions

Return ONLY valid JSON — no markdown, no explanation:
[{
  "externalId": "123",
  "assignments": [
    {"category": "ai-resources", "confidence": 0.92},
    {"category": "dev-tools", "confidence": 0.71}
  ]
}]

ITEMS:
${JSON.stringify(itemData, null, 1)}`;
}

function parseCategorizationResponse(
	text: string,
	validSlugs: Set<string>,
): CategorizationResult[] {
	const parsed = extractJsonArray(text);
	return parsed.map((raw) => {
		const item = raw as Record<string, unknown>;
		const externalId = String(item.externalId ?? item.tweetId ?? "");
		const rawAssignments = Array.isArray(item.assignments)
			? item.assignments
			: [];
		const assignments: CategoryAssignment[] = (
			rawAssignments as Record<string, unknown>[]
		)
			.map((a) => ({
				category: String(a.category ?? ""),
				confidence:
					typeof a.confidence === "number"
						? Math.min(1, Math.max(0.5, a.confidence))
						: 0.8,
			}))
			.filter((a) => validSlugs.has(a.category));
		return { externalId, assignments };
	});
}

export async function categorizeBatch(
	bookmarks: ItemForCategorization[],
): Promise<CategorizationResult[]> {
	if (bookmarks.length === 0) return [];
	const dbCategories = await db
		.select({
			slug: categories.slug,
			name: categories.name,
			description: categories.description,
		})
		.from(categories);
	const allSlugs = dbCategories.map((c) => c.slug);
	const categoryDescriptions = Object.fromEntries(
		dbCategories.map((c) => [c.slug, c.description.trim() || c.name]),
	);
	const prompt = buildCategorizationPrompt(
		bookmarks,
		categoryDescriptions,
		allSlugs,
	);
	const text = await completePrompt(prompt, {
		maxTokens: 2048,
		timeoutMs: 60_000,
	});
	return parseCategorizationResponse(text, new Set(allSlugs));
}

export async function writeCategoryResults(
	results: CategorizationResult[],
): Promise<void> {
	if (results.length === 0) return;
	const externalIds = results.map((r) => r.externalId).filter(Boolean);
	if (externalIds.length === 0) return;

	const [allCategories, rows] = await Promise.all([
		db.select({ id: categories.id, slug: categories.slug }).from(categories),
		db
			.select({ id: items.id, externalId: items.externalId })
			.from(items)
			.where(
				and(inArray(items.externalId, externalIds), isNull(items.archivedAt)),
			),
	]);

	const categoryBySlug = new Map(allCategories.map((c) => [c.slug, c.id]));
	const itemByExternalId = new Map(rows.map((r) => [r.externalId, r.id]));
	const now = new Date();
	const itemIdsToUpdate: string[] = [];

	for (const result of results) {
		const itemId = itemByExternalId.get(result.externalId);
		if (!itemId || result.assignments.length === 0) continue;
		itemIdsToUpdate.push(itemId);

		for (const { category: slug, confidence } of result.assignments) {
			const categoryId = categoryBySlug.get(slug);
			if (!categoryId) continue;
			await db
				.insert(itemCategories)
				.values({ itemId, categoryId, confidence })
				.onConflictDoUpdate({
					target: [itemCategories.itemId, itemCategories.categoryId],
					set: { confidence },
				});
		}
	}

	if (itemIdsToUpdate.length > 0) {
		await db
			.update(items)
			.set({ categorizedAt: now })
			.where(inArray(items.id, itemIdsToUpdate));
	}
}

export function mapItemForCategorization(row: {
	externalId: string;
	text: string;
	entities: string | null;
	understanding: string | null;
}): ItemForCategorization {
	let hashtags: string[] | undefined;
	let tools: string[] | undefined;
	if (row.entities) {
		try {
			const ent = JSON.parse(row.entities) as {
				hashtags?: string[];
				tools?: string[];
			};
			hashtags = ent.hashtags;
			tools = ent.tools;
		} catch {
			/* ignore */
		}
	}
	let tags: string[] | undefined;
	if (row.understanding) {
		try {
			const u = JSON.parse(row.understanding) as { tags?: string[] };
			tags = u.tags;
		} catch {
			/* ignore */
		}
	}
	return { externalId: row.externalId, text: row.text, tags, hashtags, tools };
}

export { BATCH_SIZE as CATEGORIZE_BATCH_SIZE };
