import type { ArticleContentNode, ParsedArticleContent } from "@repo/import";

function LinkifiedText({ text }: { text: string }) {
	const parts = text.split(/(https?:\/\/[^\s]+)/g);
	return (
		<>
			{parts.map((part, index) =>
				/^https?:\/\//.test(part) ? (
					<a
						key={index}
						href={part}
						target="_blank"
						rel="noreferrer"
						className="text-violet-300 underline decoration-violet-300/40 hover:text-violet-200"
					>
						{part}
					</a>
				) : (
					<span key={index}>{part}</span>
				),
			)}
		</>
	);
}

function ArticleTweetEmbed({ tweetId, url }: { tweetId: string; url: string }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			className="my-4 block rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3 transition hover:border-zinc-700"
		>
			<p className="font-mono text-[11px] tracking-wide text-zinc-500 uppercase">
				Embedded post
			</p>
			<p className="mt-1 text-sm text-zinc-300">View on X</p>
			<p className="mt-1 font-mono text-xs text-zinc-600">#{tweetId}</p>
		</a>
	);
}

function ArticleNode({ node }: { node: ArticleContentNode }) {
	if (node.type === "heading") {
		const className =
			node.level === 2
				? "mt-6 text-base font-semibold text-zinc-100"
				: "mt-5 text-sm font-semibold text-zinc-100";
		return <h3 className={className}>{node.text}</h3>;
	}
	if (node.type === "image") {
		return (
			<img
				src={node.url}
				alt=""
				loading="lazy"
				className="my-4 w-full rounded-lg border border-zinc-800 bg-zinc-900 object-cover"
			/>
		);
	}
	if (node.type === "tweet") {
		return <ArticleTweetEmbed tweetId={node.tweetId} url={node.url} />;
	}
	return (
		<p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
			<LinkifiedText text={node.text} />
		</p>
	);
}

export function ArticleBody({
	content,
	fallbackText,
}: {
	content: ParsedArticleContent | null | undefined;
	fallbackText?: string;
}) {
	if (!content?.nodes.length) {
		if (!fallbackText) return null;
		return (
			<p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
				<LinkifiedText text={fallbackText} />
			</p>
		);
	}

	return (
		<div className="mt-3">
			{content.coverUrl ? (
				<img
					src={content.coverUrl}
					alt=""
					loading="lazy"
					className="mb-4 w-full rounded-lg border border-zinc-800 bg-zinc-900 object-cover"
				/>
			) : null}
			{content.nodes.map((node, index) => (
				<ArticleNode key={`${node.type}-${index}`} node={node} />
			))}
		</div>
	);
}

export function articleContentHasInlineMedia(
	content: ParsedArticleContent | null | undefined,
): boolean {
	if (!content) return false;
	if (content.coverUrl) return true;
	return content.nodes.some((node) => node.type === "image");
}
