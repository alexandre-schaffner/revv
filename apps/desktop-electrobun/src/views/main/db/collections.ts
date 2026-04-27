import {
	createBrowserWASQLitePersistence,
	openBrowserWASQLiteOPFSDatabase,
	persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import {
	createCollection,
	localOnlyCollectionOptions,
} from "@tanstack/solid-db";
import { workspaceSchema } from "./schema";

let _workspaceCollection: any = null;
let _initPromise: Promise<void> | null = null;
let _initError: unknown = null;

async function doInit() {
	try {
		const database = await openBrowserWASQLiteOPFSDatabase({
			databaseName: "revv-desktop.sqlite",
		});

		const persistence = createBrowserWASQLitePersistence({
			database,
		});

		const options = persistedCollectionOptions({
			...localOnlyCollectionOptions({
				id: "workspaces",
				schema: workspaceSchema,
				getKey: (item: any) => item.id,
			} as any),
			persistence,
			schemaVersion: 1,
		});

		_workspaceCollection = (createCollection as any)(options);
	} catch (err) {
		console.warn("SQLite WASM persistence failed, falling back to in-memory:", err);
		// Fallback: pure in-memory collection
		_workspaceCollection = (createCollection as any)(
			localOnlyCollectionOptions({
				id: "workspaces",
				schema: workspaceSchema,
				getKey: (item: any) => item.id,
			} as any),
		);
	}
}

export async function initCollections() {
	if (!_initPromise) {
		_initPromise = doInit().catch((err) => {
			_initError = err;
			throw err;
		});
	}
	await _initPromise;
}

export function getWorkspaceCollection(): any {
	if (!_workspaceCollection) {
		throw new Error("Collections not initialized. Call initCollections() first.");
	}
	return _workspaceCollection;
}

export function getInitError() {
	return _initError;
}

export type { Workspace } from "./schema";
export { workspaceSchema };
