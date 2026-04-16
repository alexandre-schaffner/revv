import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';

export const workerManager =
	typeof window !== 'undefined'
		? getOrCreateWorkerPoolSingleton({
				poolOptions: {
					workerFactory: () =>
						new Worker(
							new URL(
								'@pierre/diffs/worker/worker-portable.js',
								import.meta.url
							),
							{ type: 'module' }
						),
					poolSize: 2
				},
				highlighterOptions: {
					langs: [
						'typescript',
						'javascript',
						'svelte',
						'css',
						'json',
						'python',
						'go',
						'rust',
						'html',
						'shellscript',
						'yaml',
						'sql'
					],
					theme: { dark: 'pierre-dark', light: 'pierre-light' }
				}
			})
		: undefined;
