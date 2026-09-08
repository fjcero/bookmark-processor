const DB_NAME = "bookmark-processor";
const STORE = "state";
export const IMPORT_QUEUE_STORE = "importQueue";

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

export async function idbSet(key: string, value: unknown): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
	});
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
	});
}

export async function idbGetAllFromStore<T>(
	storeName: string,
): Promise<T[]> {
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
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		tx.objectStore(storeName).put(value);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
	});
}

export async function idbDeleteFromStore(
	storeName: string,
	key: IDBValidKey,
): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(storeName, "readwrite");
		tx.objectStore(storeName).delete(key);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
	});
}
