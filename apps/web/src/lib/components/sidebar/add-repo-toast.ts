import { toast } from "svelte-sonner";
import { AddRepoError } from "$lib/stores/prs.svelte";

/**
 * Surface a failed add. A diagnosed rejection keeps its explanation on screen
 * until dismissed, with a button to the GitHub page that grants access.
 */
export function toastAddRepoError(e: unknown, fallback: string): void {
  if (!(e instanceof AddRepoError) || e.detail === null) {
    toast.error(e instanceof Error ? e.message : fallback);
    return;
  }
  const { action } = e;
  toast.error(e.message, {
    description: e.detail,
    ...(action
      ? {
          action: {
            label: action.label,
            onClick: () => {
              void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(action.url));
            },
          },
          duration: Number.POSITIVE_INFINITY,
        }
      : {}),
  });
}
