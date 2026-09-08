/**
 * Zero-cost entity extraction from stored rawJson tweet data.
 * No AI calls — pure data mining from already-stored JSON.
 */

import {
	articleMediaUrls,
	articleResultFromTweet,
	articleUrl,
	contentTypeOfTweet,
	derivePostFormat,
	type ContentType,
	type PostFormat,
} from "@repo/import";

export interface ExtractedEntities {
	hashtags: string[];
	urls: string[];
	mentions: string[];
	tools: string[];
	contentType: ContentType;
	tweetType: PostFormat;
	hasMedia: boolean;
	mediaTypes: string[];
	mediaUrls: string[];
}

const KNOWN_TOOL_DOMAINS: Record<string, string> = {
	"github.com": "GitHub",
	"gitlab.com": "GitLab",
	"bitbucket.org": "Bitbucket",
	"stackoverflow.com": "Stack Overflow",
	"replit.com": "Replit",
	"codepen.io": "CodePen",
	"codesandbox.io": "CodeSandbox",
	"stackblitz.com": "StackBlitz",
	"glitch.com": "Glitch",
	"npmjs.com": "npm",
	"pypi.org": "PyPI",
	"crates.io": "crates.io",
	"docker.com": "Docker",
	"hub.docker.com": "Docker Hub",
	"vercel.com": "Vercel",
	"netlify.com": "Netlify",
	"railway.app": "Railway",
	"render.com": "Render",
	"fly.io": "Fly.io",
	"supabase.com": "Supabase",
	"planetscale.com": "PlanetScale",
	"neon.tech": "Neon",
	"turso.tech": "Turso",
	"cloudflare.com": "Cloudflare",
	"aws.amazon.com": "AWS",
	"console.aws.amazon.com": "AWS",
	"cloud.google.com": "Google Cloud",
	"azure.microsoft.com": "Azure",
	"linear.app": "Linear",
	"jira.atlassian.com": "Jira",
	"atlassian.com": "Atlassian",
	"huggingface.co": "HuggingFace",
	"arxiv.org": "arxiv",
	"openai.com": "OpenAI",
	"anthropic.com": "Anthropic",
	"replicate.com": "Replicate",
	"perplexity.ai": "Perplexity",
	"midjourney.com": "Midjourney",
	"runwayml.com": "Runway",
	"elevenlabs.io": "ElevenLabs",
	"lmsys.org": "LMSys",
	"together.ai": "Together AI",
	"groq.com": "Groq",
	"mistral.ai": "Mistral",
	"cohere.com": "Cohere",
	"stability.ai": "Stability AI",
	"deepmind.google": "DeepMind",
	"colab.research.google.com": "Google Colab",
	"kaggle.com": "Kaggle",
	"wandb.ai": "Weights & Biases",
	"modal.com": "Modal",
	"fireworks.ai": "Fireworks AI",
	"anyscale.com": "Anyscale",
	"cursor.sh": "Cursor",
	"cursor.com": "Cursor",
	"v0.dev": "v0",
	"bolt.new": "Bolt",
	"lovable.dev": "Lovable",
	"devin.ai": "Devin",
	"figma.com": "Figma",
	"framer.com": "Framer",
	"dribbble.com": "Dribbble",
	"behance.net": "Behance",
	"canva.com": "Canva",
	"spline.design": "Spline",
	"lottiefiles.com": "LottieFiles",
	"notion.so": "Notion",
	"obsidian.md": "Obsidian",
	"roamresearch.com": "Roam Research",
	"logseq.com": "Logseq",
	"airtable.com": "Airtable",
	"coda.io": "Coda",
	"miro.com": "Miro",
	"loom.com": "Loom",
	"cal.com": "Cal.com",
	"youtube.com": "YouTube",
	"youtu.be": "YouTube",
	"substack.com": "Substack",
	"medium.com": "Medium",
	"producthunt.com": "Product Hunt",
	"app.daily.dev": "daily.dev",
	"hackernews.com": "Hacker News",
	"news.ycombinator.com": "Hacker News",
	"dev.to": "dev.to",
	"hashnode.com": "Hashnode",
	"beehiiv.com": "Beehiiv",
	"discord.com": "Discord",
	"discord.gg": "Discord",
	"slack.com": "Slack",
	"reddit.com": "Reddit",
	"telegram.org": "Telegram",
	"t.me": "Telegram",
	"coinbase.com": "Coinbase",
	"binance.com": "Binance",
	"uniswap.org": "Uniswap",
	"opensea.io": "OpenSea",
	"dune.com": "Dune Analytics",
	"etherscan.io": "Etherscan",
	"solscan.io": "Solscan",
	"defillama.com": "DefiLlama",
};

function extractDomain(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return null;
	}
}

function detectTools(urls: string[]): string[] {
	const tools = new Set<string>();
	for (const url of urls) {
		const domain = extractDomain(url);
		if (!domain) continue;
		if (KNOWN_TOOL_DOMAINS[domain]) {
			tools.add(KNOWN_TOOL_DOMAINS[domain]);
			continue;
		}
		for (const [knownDomain, toolName] of Object.entries(KNOWN_TOOL_DOMAINS)) {
			if (domain.endsWith(knownDomain)) {
				tools.add(toolName);
				break;
			}
		}
	}
	return Array.from(tools);
}

function safeGet(obj: unknown, ...keys: string[]): unknown {
	let cur: unknown = obj;
	for (const k of keys) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[k];
	}
	return cur;
}

function mediaUrlFromObject(m: Record<string, unknown>): string | null {
	const url = String(m.media_url_https ?? m.url ?? "");
	if (!url) return null;
	const type = String(m.type ?? "photo");
	if (type === "photo" || type === "animated_gif" || type === "video")
		return url;
	return url;
}

export function extractMediaUrls(rawJson: string): string[] {
	if (!rawJson) return [];
	let tweet: unknown;
	try {
		tweet = JSON.parse(rawJson);
	} catch {
		return [];
	}
	const mediaArr: unknown[] =
		(safeGet(tweet, "extended_entities", "media") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "extended_entities", "media") as
			| unknown[]
			| undefined) ??
		(safeGet(tweet, "entities", "media") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "entities", "media") as unknown[] | undefined) ??
		[];
	const urls: string[] = [];
	for (const entry of mediaArr) {
		if (!entry || typeof entry !== "object") continue;
		const url = mediaUrlFromObject(entry as Record<string, unknown>);
		if (url) urls.push(url);
	}
	const article = articleResultFromTweet(tweet);
	for (const url of articleMediaUrls(article)) {
		if (!urls.includes(url)) urls.push(url);
	}
	return urls;
}

export function mediaUrlsForItem(
	entitiesJson: string | null,
	rawJson: string,
): string[] {
	if (entitiesJson) {
		try {
			const parsed = JSON.parse(entitiesJson) as { mediaUrls?: string[] };
			if (parsed.mediaUrls?.length) return parsed.mediaUrls;
		} catch {
			/* fall through */
		}
	}
	return extractMediaUrls(rawJson);
}

export function extractEntities(rawJson: string): ExtractedEntities {
	const empty: ExtractedEntities = {
		hashtags: [],
		urls: [],
		mentions: [],
		tools: [],
		contentType: "post",
		tweetType: "original",
		hasMedia: false,
		mediaTypes: [],
		mediaUrls: [],
	};

	if (!rawJson) return empty;

	let tweet: unknown;
	try {
		tweet = JSON.parse(rawJson);
	} catch {
		return empty;
	}

	const hashtagObjs: unknown[] =
		(safeGet(tweet, "entities", "hashtags") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "entities", "hashtags") as
			| unknown[]
			| undefined) ??
		[];
	const hashtags = (hashtagObjs as Record<string, unknown>[])
		.map((h) => String(h.tag ?? h.text ?? "").toLowerCase())
		.filter(Boolean);

	const urlObjs: unknown[] =
		(safeGet(tweet, "entities", "urls") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "entities", "urls") as unknown[] | undefined) ??
		[];
	const urls = (urlObjs as Record<string, unknown>[])
		.map((u) => String(u.expanded_url ?? u.url ?? ""))
		.filter((u) => {
			if (!u) return false;
			if (u.includes("t.co/")) return false;
			if (u.includes("/i/article/")) return true;
			return !u.includes("twitter.com") && !u.includes("x.com/");
		});

	const article = articleResultFromTweet(tweet);
	const articleId = article?.rest_id;
	if (articleId) {
		const canonical = articleUrl(articleId);
		if (!urls.includes(canonical)) urls.push(canonical);
	}

	const mentionObjs: unknown[] =
		(safeGet(tweet, "entities", "user_mentions") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "entities", "user_mentions") as
			| unknown[]
			| undefined) ??
		[];
	const mentions = (mentionObjs as Record<string, unknown>[])
		.map((m) => String(m.screen_name ?? m.username ?? "").toLowerCase())
		.filter(Boolean);

	const tweetType = derivePostFormat(tweet);
	const contentType = contentTypeOfTweet(tweet);

	const mediaArr: unknown[] =
		(safeGet(tweet, "entities", "media") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "entities", "media") as unknown[] | undefined) ??
		(safeGet(tweet, "extended_entities", "media") as unknown[] | undefined) ??
		(safeGet(tweet, "legacy", "extended_entities", "media") as
			| unknown[]
			| undefined) ??
		[];
	const mediaUrls = [
		...new Set([
			...(mediaArr as Record<string, unknown>[])
				.map((m) => mediaUrlFromObject(m))
				.filter((u): u is string => Boolean(u)),
			...articleMediaUrls(article),
		]),
	];
	const hasMedia = mediaUrls.length > 0;
	const mediaTypes = [
		...new Set(
			[
				...(mediaArr as Record<string, unknown>[]).map((m) =>
					String(m.type ?? ""),
				),
				...(articleMediaUrls(article).length > 0 ? ["photo"] : []),
			].filter(Boolean),
		),
	];

	const tools = detectTools(urls);

	return {
		hashtags,
		urls,
		mentions,
		tools,
		contentType,
		tweetType,
		hasMedia,
		mediaTypes,
		mediaUrls,
	};
}
