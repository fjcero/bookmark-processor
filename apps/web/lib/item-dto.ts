import type { ContentType, PostFormat } from "@repo/import";
import type { EmbeddedTweet } from "./embeds";
import type { ItemRow } from "./queries";

export interface ClientItem {
	id: string;
	source: string;
	externalId: string;
	text: string;
	kind: string;
	contentType?: ContentType;
	postFormat?: PostFormat;
	articleHydrated?: boolean;
	articleRefetching?: boolean;
	articleTitle?: string | null;
	articlePreview?: string | null;
	url: string | null;
	publishedAt: string | null;
	importedAt: string;
	sortIndex: string | null;
	categorizedAt: string | null;
	understanding: string | null;
	entities: string | null;
	mediaUrls: string[];
	embeds: EmbeddedTweet[];
	handle: string;
	name: string;
	avatarUrl: string | null;
	categories: {
		slug: string;
		name: string;
		color: string;
		confidence: number;
	}[];
}

export function toClientItem(item: ItemRow): ClientItem {
	return {
		id: item.id,
		source: item.source,
		externalId: item.externalId,
		text: item.text,
		kind: item.kind,
		contentType: item.contentType,
		postFormat: item.postFormat,
		articleHydrated: item.articleHydrated,
		articleRefetching: item.articleRefetching,
		articleTitle: item.articleTitle,
		articlePreview: item.articlePreview,
		url: item.url,
		publishedAt: item.publishedAt?.toISOString() ?? null,
		importedAt: item.importedAt.toISOString(),
		sortIndex: item.sortIndex,
		categorizedAt: item.categorizedAt?.toISOString() ?? null,
		understanding: item.understanding,
		entities: item.entities,
		mediaUrls: item.mediaUrls,
		embeds: item.embeds,
		handle: item.handle,
		name: item.name,
		avatarUrl: item.avatarUrl,
		categories: item.categories,
	};
}
