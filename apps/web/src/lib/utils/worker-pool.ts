import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import { PIERRE_DIFF_PRELOAD_LANGS, PIERRE_THEME } from "@revv/shared";

function getWorkerPoolSize(): number {
  const cores = navigator.hardwareConcurrency;
  if (!Number.isFinite(cores)) return 2;
  return Math.max(1, Math.min(4, Math.floor(cores) - 1));
}

export const workerManager =
  typeof window !== "undefined"
    ? getOrCreateWorkerPoolSingleton({
        poolOptions: {
          workerFactory: () =>
            new Worker(new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url), {
              type: "module",
            }),
          poolSize: getWorkerPoolSize(),
        },
        highlighterOptions: {
          langs: [...PIERRE_DIFF_PRELOAD_LANGS],
          theme: PIERRE_THEME,
        },
      })
    : undefined;
