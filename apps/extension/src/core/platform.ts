import type {
	ArticleQueueCounts,
	ArticleQueueEntry,
	SyncRevocation,
} from "@repo/import";

export type MessageHandler = (
	message: Record<string, unknown>,
	sender: chrome.runtime.MessageSender,
) => Promise<unknown>;

export class MessageRouter {
	private readonly handlers = new Map<string, MessageHandler>();

	register(type: string, handler: MessageHandler): void {
		this.handlers.set(type, handler);
	}

	async dispatch(
		message: unknown,
		sender: chrome.runtime.MessageSender,
	): Promise<unknown> {
		if (!message || typeof message !== "object") return null;
		const type = (message as Record<string, unknown>).type;
		if (typeof type !== "string") return null;
		const handler = this.handlers.get(type);
		if (!handler) return null;
		return handler(message as Record<string, unknown>, sender);
	}
}

export type AlarmHandler = (alarm: chrome.alarms.Alarm) => void;

export class AlarmRegistry {
	private readonly exact = new Map<string, AlarmHandler>();
	private readonly prefixes: Array<{ prefix: string; handler: AlarmHandler }> =
		[];

	register(nameOrPrefix: string, handler: AlarmHandler): void {
		if (nameOrPrefix.endsWith(":")) {
			this.prefixes.push({ prefix: nameOrPrefix, handler });
			return;
		}
		this.exact.set(nameOrPrefix, handler);
	}

	dispatch(alarm: chrome.alarms.Alarm): boolean {
		const exact = this.exact.get(alarm.name);
		if (exact) {
			exact(alarm);
			return true;
		}
		for (const { prefix, handler } of this.prefixes) {
			if (alarm.name.startsWith(prefix)) {
				handler(alarm);
				return true;
			}
		}
		return false;
	}
}

export interface StatusSlice {
	articles: ArticleQueueCounts;
	articleQueue?: ArticleQueueEntry[];
	captureScrollActive?: boolean;
	rateLimitedUntil?: number;
}

export interface ExtensionPlatform {
	id: string;
	tabUrlPatterns: string[];
	bootstrap(): Promise<void>;
	registerMessageHandlers(router: MessageRouter): void;
	registerAlarmHandlers(alarms: AlarmRegistry): void;
	onTabRemoved(tabId: number): Promise<void>;
	buildStatusSlice(): Promise<StatusSlice>;
	applyRevocations(revocations: SyncRevocation[]): Promise<void>;
}

const platforms: ExtensionPlatform[] = [];

export function registerPlatform(platform: ExtensionPlatform): void {
	platforms.push(platform);
}

export function getPlatforms(): readonly ExtensionPlatform[] {
	return platforms;
}

export function allTabUrlPatterns(): string[] {
	return [...new Set(platforms.flatMap((platform) => platform.tabUrlPatterns))];
}
