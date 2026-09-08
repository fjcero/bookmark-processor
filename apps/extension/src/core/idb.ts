import { broadcastToTabs } from "./broadcast";
import { allTabUrlPatterns } from "./platform";
import { isStorageQuotaError } from "./storage-quota";

const DB_NAME = "bookmark-processor";
const STORE = "state";
export const IMPORT_QUEUE_STORE = "importQueue";

const QUOTA_TAB_PATTERNS = ["https://x.com/*", "https://twitter.com/*"];

let quotaRecovery: (() => Promise<void>) | null = null;
let recovering = false;

export function setQuotaRecoveryHandler(handler: () => Promise<void>): void {
	quotaRecovery = handler;
}

export { isStorageQuotaError };

async function notifyQuotaFailure(): Promise<void> {
	const patterns = allTabUrlPatterns();
	await broadcastToTabs(patterns.length > 0 ? patterns : QUOTA_TAB_PATTERNS, {
		type: "bp-storage-quota-error",
	});
}

async function withQuotaRetry<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op();
	} catch (err) {
		if (!isStorageQuotaError(err) || recovering || !quotaRecovery) throw err;
		recovering = true;
		try {
			await quotaRecovery();
		} finally {
			recovering = false;
		}
		try {
			return await op();
		} catch (retryErr) {
			if (isStorageQuotaError(retryErr)) {
				await notifyQuotaFailure();
			}
			throw retryErr;
		}
	}
}

export function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 2);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) {
				request.result.createObjectStore(STORE);
			}
			if (!request.result.objectStoreNames.contains(IMPORT_QUEUE_STORE)) {
				request.result.createObjectStore(IMPORT_QUEUE_STORE, {
					keyPath: "externalId",
				});
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function idbGet<T>(key: string): Promise<T | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const req = tx.objectStore(STORE).get(key);
		req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
		req.onerror = () => reject(req.error);
		tx.oncomplete = () => db.close();
	});
}

async function idbSetOnce(key: string, value: unknown): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export async function idbSet(key: string, value: unknown): Promise<void> {
	await withQuotaRetry(() => idbSetOnce(key, value));
}

export async function idbDelete(key: string): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).delete(key);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

async function idbUpdateOnce<T>(
	key: string,
	update: (current: T | null) => T,
): Promise<T> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		const get = store.get(key);
		let next: T;
		get.onsuccess = () => {
			next = update((get.result as T | undefined) ?? null);
			store.put(next, key);
		};
		get.onerror = () => reject(get.error);
		tx.oncomplete = () => {
			db.close();
			resolve(next!);
		};
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

/** Atomically read and replace one value in the state store. */
export async function idbUpdate<T>(
	key: string,
	update: (current: T | null) => T,
): Promise<T> {
	return withQuotaRetry(() => idbUpdateOnce(key, update));
}

export async function idbGetAllFromStore<T>(storeName: string): Promise<T[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readonly");
		const req = tx.objectStore(storeName).getAll();
		req.onsuccess = () => resolve((req.result as T[] | undefined) ?? []);
		req.onerror = () => reject(req.error);
		tx.oncomplete = () => db.close();
	});
}

export async function idbPutToStore(
	storeName: string,
	value: unknown,
): Promise<void> {
	await idbPutManyToStore(storeName, [value]);
}

async function idbPutManyToStoreOnce(
	storeName: string,
	values: unknown[],
): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		const store = tx.objectStore(storeName);
		for (const value of values) store.put(value);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export async function idbPutManyToStore(
	storeName: string,
	values: unknown[],
): Promise<void> {
	if (values.length === 0) return;
	await withQuotaRetry(() => idbPutManyToStoreOnce(storeName, values));
}

export async function idbDeleteFromStore(
	storeName: string,
	key: IDBValidKey,
): Promise<void> {
	await idbDeleteManyFromStore(storeName, [key]);
}

export async function idbDeleteManyFromStore(
	storeName: string,
	keys: IDBValidKey[],
): Promise<void> {
	if (keys.length === 0) return;
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		const store = tx.objectStore(storeName);
		for (const key of keys) store.delete(key);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}
